/**
 * v5 Desk — the pure presentation logic of the rebuilt screen.
 *
 * Everything here is a function of numbers the SERVER produced: no clock (a
 * `now` is always a parameter), no fetch, no React state. The Desk's arithmetic
 * — the gate rows, the pipeline states, the day percentage, the open-risk sum,
 * the tab/URL mapping — is testable in isolation, in the style of
 * `learning.test.ts`, and a reviewer can check what a colour or a row means
 * without running a browser.
 *
 * The honesty rule of the whole screen lives here: when a value the design
 * wants does not exist on the wire, these functions return null and the
 * component renders an em dash. Nothing returns a zero that could be mistaken
 * for a measurement.
 */

import {
  DESK_TABS,
  DESK_THRESHOLDS,
  ROLLOUT_STAGES,
  type DeskTab,
} from "@/components/desk/desk-layout";
import type {
  AgentDecision,
  DeskStateResponse,
  DeskV4Summary,
  EvidenceResult,
  FeedStatus,
  Instrument,
  RegimeRead,
  ScanRow,
  Position,
} from "./desk";

// ── tab ⇄ URL state ─────────────────────────────────────────────────────────

/** Parse `?tab=` (with or without the leading "?"); anything else is Command. */
export function deskTabFromSearch(search: string): DeskTab {
  const raw = search.replace(/^\?/, "");
  const tab = new URLSearchParams(raw).get("tab");
  return DESK_TABS.includes(tab as DeskTab) ? (tab as DeskTab) : "command";
}

/** The query string a tab writes into the URL (always explicit, so links work). */
export function deskSearchForTab(tab: DeskTab): string {
  return `?tab=${tab}`;
}

// ── title-bar maths ─────────────────────────────────────────────────────────

/**
 * Today's result as a percentage of the day's starting equity.
 * Null whenever the terminal has not stamped a day-start equity — a missing
 * baseline renders as an em dash, never as 0.00%.
 */
export function dayChangePct(
  equity: number | null | undefined,
  dayStartEquity: number | null | undefined,
): number | null {
  if (equity === null || equity === undefined || !Number.isFinite(equity)) return null;
  if (dayStartEquity === null || dayStartEquity === undefined || !Number.isFinite(dayStartEquity)) return null;
  if (dayStartEquity === 0) return null;
  return ((equity - dayStartEquity) / dayStartEquity) * 100;
}

/** The desk's open risk (heat): the sum of every exposure's risk percent. */
export function openRiskPct(exposure: { riskPct: number }[] | undefined | null): number {
  if (!exposure || exposure.length === 0) return 0;
  return exposure.reduce((sum, entry) => sum + (Number.isFinite(entry.riskPct) ? entry.riskPct : 0), 0);
}

/**
 * The Positions footer's net-open line: money across every position, R across
 * only the positions whose initial risk the EA stamped, and the count of the
 * unstampable ones — an R total over part of the book is labelled as such
 * rather than pretending to cover it.
 */
export function netOpenResults(positions: Position[]): { money: number; r: number | null; unmeasured: number } {
  let money = 0;
  let r = 0;
  let measured = 0;
  let unmeasured = 0;
  for (const position of positions) {
    money += position.profit + position.swap + position.commission;
    if (typeof position.initialRiskMoney === "number" && position.initialRiskMoney > 0) {
      r += (position.profit + position.swap + position.commission) / position.initialRiskMoney;
      measured++;
    } else {
      unmeasured++;
    }
  }
  return { money, r: measured > 0 ? r : null, unmeasured };
}

/** "Committed risk x% — plans add y%": open heat, plus what the armed plans would add. */
export function committedRisk(state: DeskStateResponse | null | undefined): {
  committedPct: number;
  plansAddPct: number | null;
} {
  if (!state) return { committedPct: 0, plansAddPct: null };
  const committedPct = openRiskPct(state.risk.exposure);
  const equity = state.account?.equity ?? null;
  if (equity === null || equity <= 0 || state.plans.length === 0) {
    return { committedPct, plansAddPct: equity !== null && equity > 0 ? 0 : null };
  }
  const plansMoney = state.plans.reduce((sum, plan) => sum + (Number.isFinite(plan.riskMoney) ? plan.riskMoney : 0), 0);
  return { committedPct, plansAddPct: (plansMoney / equity) * 100 };
}

// ── formatting (tabular, signed where a sign is meaning) ────────────────────

/** A percentage, or an em dash. Never a zero standing in for "unknown". */
export function formatPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

/** A signed percentage for results: +0.42% and −0.42% must not look alike. */
export function formatSignedPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}%`;
}

/** A signed R multiple: "+1.4R". */
export function formatSignedR(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}R`;
}

/** A price at the instrument's own digits, or an em dash. */
export function formatPrice(value: number | null, digits: number | null): string {
  if (value === null || digits === null || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

/**
 * A plan-expiry countdown in the units that matter at that distance:
 * "42s", "4m 12s", "2h 05m", "expired". Seconds are explicit because a plan
 * dies in minutes and "in 4m" hides whether it is 4m00s or 4m59s away.
 */
export function shortCountdown(targetMs: number, nowMs: number): string {
  const diff = targetMs - nowMs;
  if (!Number.isFinite(diff) || diff <= 0) return "expired";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The order-style word for a plan's trigger type (the pipeline's L5 line). */
export function triggerTypeLabel(triggerType: string | null | undefined): string | null {
  switch (triggerType) {
    case "limit": return "Limit order";
    case "stop": return "Stop order";
    case "market": return "Market order";
    case "break": return "Break stop";
    case "retest": return "Retest limit";
    case "confirm": return "Confirm stop";
    default: return null;
  }
}

/** The regime state's human label ("trend_up" → "Trend up"). */
export function regimeStateLabel(state: string | null | undefined): string | null {
  if (!state) return null;
  const spaced = state.replace(/_/g, " ").replace(/-/g, " ").trim();
  if (!spaced) return state;
  // Sentence case, matching the server's own regime labels ("Trend up", not
  // "Trend Up") — words after the first stay lowercase.
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The dominant posterior probability of a regime read, or null. */
export function regimeTopProbability(read: RegimeRead | null | undefined): number | null {
  if (!read || !read.available) return null;
  const values = Object.values(read.posterior ?? {}).filter((value) => Number.isFinite(value));
  if (values.length === 0) return null;
  return Math.max(...values);
}

// ── the Decision panel's gate rows ─────────────────────────────────────────

export interface GateRow {
  id: string;
  label: string;
  pass: boolean;
  /** The measured value, formatted; null ⇒ em dash. */
  value: string | null;
  /** What it had to beat, formatted; null ⇒ no threshold applies. */
  threshold: string | null;
  valueNum: number | null;
  thresholdNum: number | null;
  /** One plain-language sentence — the gatekeeper's own, or the rejection. */
  detail: string | null;
}

export interface GateRowInputs {
  decision: AgentDecision | null;
  /** /analysis `thresholds` (server constants); optional on older servers. */
  thresholds?: { minRrFill: number; minCostCoverage: number; minEdgeR: number } | null;
  /** The selected symbol's regime read from ["desk-regime"], when served. */
  regime?: RegimeRead | null;
  /** Sum of risk.exposure[].riskPct, when an account snapshot exists. */
  openRiskPctValue?: number | null;
  /** policy.maxCurrencyExposurePct. */
  exposureCapPct?: number | null;
  /** risk.budget.usedPct (0–100), when a budget exists. */
  dailyLossUsedPct?: number | null;
  halted?: boolean;
}

/** The gatekeeper's own record of one gate, by code. */
function gkReason(decision: AgentDecision, code: string) {
  return decision.gatekeeper?.reasons.find((reason) => reason.code === code) ?? null;
}

/** The first rejection sentence containing `needle`, for legacy-path detail. */
function rejectionLike(decision: AgentDecision, needle: RegExp): string | null {
  return decision.rejections.find((reason) => needle.test(reason)) ?? null;
}

const EPS = 1e-9;

/**
 * Build the Decision panel's edge-gate rows.
 *
 * The rows render in the brief's order, ONLY when the data for a row exists:
 * gatekeeper-supplied rows carry the server's own value, threshold and
 * sentence; the legacy (v4-off) path derives pass/fail from the same constants
 * the server enforced (`/analysis thresholds`), never from a number the UI
 * picked. When the decision is not armed, failing rows come first — that is
 * the sort the caller asked for and it is stable inside each group.
 */
export function buildGateRows(input: GateRowInputs): GateRow[] {
  const { decision } = input;
  if (!decision) return [];
  const rows: GateRow[] = [];
  const gk = decision.gatekeeper ?? null;
  const thresholds = input.thresholds ?? null;

  // 1. Reward : risk at the fill.
  {
    const reason = gk ? gkReason(decision, "GK_RR_FILL") : null;
    if (reason) {
      rows.push({
        id: "rr-fill",
        label: "Reward : risk at fill",
        pass: reason.pass,
        value: reason.value === null ? null : `${reason.value.toFixed(2)}R`,
        threshold: reason.threshold === null ? null : `≥ ${reason.threshold.toFixed(2)}R`,
        valueNum: reason.value,
        thresholdNum: reason.threshold,
        detail: reason.detail,
      });
    } else {
      const value = decision.monteCarlo?.rewardRisk ?? null;
      const limit = thresholds?.minRrFill ?? null;
      if (value !== null || limit !== null) {
        rows.push({
          id: "rr-fill",
          label: "Reward : risk at fill",
          pass: value !== null && limit !== null ? value >= limit - EPS : false,
          value: value === null ? null : `${value.toFixed(2)}R`,
          threshold: limit === null ? null : `≥ ${limit.toFixed(2)}R`,
          valueNum: value,
          thresholdNum: limit,
          detail: rejectionLike(decision, /Reward:risk/i),
        });
      }
    }
  }

  // 2. Edge, lower bound.
  {
    const reason = gk ? gkReason(decision, "GK_EV_LCB") : null;
    if (reason) {
      rows.push({
        id: "edge-floor",
        label: "Edge, lower bound",
        pass: reason.pass,
        value: reason.value === null ? null : `${reason.value.toFixed(2)}R`,
        threshold: reason.threshold === null ? null : `≥ ${reason.threshold.toFixed(2)}R`,
        valueNum: reason.value,
        thresholdNum: reason.threshold,
        detail: reason.detail,
      });
    } else {
      // Legacy path: the blended expectancy against the server's own floor.
      const value = decision.expectancyR ?? null;
      const limit = thresholds?.minEdgeR ?? null;
      if (value !== null && limit !== null) {
        rows.push({
          id: "edge-floor",
          label: "Edge, lower bound",
          pass: value >= limit - EPS,
          value: `${value.toFixed(2)}R`,
          threshold: `≥ ${limit.toFixed(2)}R`,
          valueNum: value,
          thresholdNum: limit,
          detail: rejectionLike(decision, /below the .*R minimum|expectancy/i),
        });
      }
      // No gatekeeper and no thresholds (older server): the row is omitted —
      // an edge row without its floor would be a guess dressed as a gate.
    }
  }

  // 3. Cost vs volatility.
  {
    const reason = gk ? gkReason(decision, "GK_COST_SIGMA") : null;
    if (reason) {
      rows.push({
        id: "cost-vol",
        label: "Cost vs volatility",
        pass: reason.pass,
        value: reason.value === null ? null : reason.value.toFixed(2),
        threshold: reason.threshold === null ? null : `≤ ${reason.threshold.toFixed(2)}`,
        valueNum: reason.value,
        thresholdNum: reason.threshold,
        detail: reason.detail,
      });
    } else if (decision.costR !== null || thresholds?.minCostCoverage != null) {
      // Legacy path: the round-trip cost as a fraction of the risk unit
      // against 1/minCostCoverage — the same invariant the server enforces
      // when it widens (or refuses) the stop.
      const limit = thresholds && thresholds.minCostCoverage > 0 ? 1 / thresholds.minCostCoverage : null;
      const value = decision.costR;
      rows.push({
        id: "cost-vol",
        label: "Cost vs volatility",
        pass: value !== null && limit !== null ? value <= limit + EPS : value !== null,
        value: value === null ? null : `${(value * 100).toFixed(0)}% of R`,
        threshold: limit === null ? null : `≤ ${(limit * 100).toFixed(0)}% of R`,
        valueNum: value,
        thresholdNum: limit,
        detail: rejectionLike(decision, /cost|spread/i),
      });
    }
  }

  // 4. Regime permits a long/short.
  {
    const reason = gk ? gkReason(decision, "GK_REGIME") : null;
    if (reason) {
      rows.push({
        id: "regime",
        label: "Regime permits the side",
        pass: reason.pass,
        value: reason.value === null ? null : reason.value.toFixed(2),
        threshold: reason.threshold === null ? null : reason.threshold.toFixed(2),
        valueNum: reason.value,
        thresholdNum: reason.threshold,
        detail: reason.detail,
      });
    } else {
      const regime = input.regime ?? null;
      const direction = decision.confluence.direction;
      if (regime && regime.available && direction !== "none") {
        const side = direction === "up" ? regime.sides.buy : regime.sides.sell;
        rows.push({
          id: "regime",
          label: "Regime permits the side",
          pass: side.permit,
          value: `${direction === "up" ? "Buy" : "Sell"} ${(side.probability * 100).toFixed(0)}%`,
          threshold: null,
          valueNum: side.probability,
          thresholdNum: null,
          detail: side.reason || (side.permit ? null : side.codes.join(", ")),
        });
      }
      // Neither source: omitted (v4 regime off is the shipped state).
    }
  }

  // 5. News, session and spread — always computable from the decision.
  {
    const news = decision.news;
    rows.push({
      id: "news",
      label: "News, session and spread",
      pass: !news.blocked,
      value: news.status === "clear" ? "Clear" : news.status === "blackout" ? "Blackout" : "Unavailable",
      threshold: null,
      valueNum: null,
      thresholdNum: null,
      detail: news.reason,
    });
  }

  // 6. Multiple-testing — only the gatekeeper measures it.
  {
    const reason = gk ? gkReason(decision, "GK_FAMILY") : null;
    if (reason) {
      rows.push({
        id: "family",
        label: "Multiple-testing",
        pass: reason.pass,
        value: reason.value === null ? null : reason.value.toFixed(3),
        threshold: reason.threshold === null ? null : `≤ ${reason.threshold.toFixed(3)}`,
        valueNum: reason.value,
        thresholdNum: reason.threshold,
        detail: reason.detail,
      });
    }
  }

  // 7. Portfolio heat — from /state, not from the decision.
  {
    const value = input.openRiskPctValue ?? null;
    const cap = input.exposureCapPct ?? null;
    if (value !== null && cap !== null && cap > 0) {
      rows.push({
        id: "heat",
        label: "Portfolio heat",
        pass: value < cap - EPS,
        value: value.toFixed(2) + "%",
        threshold: `< ${cap.toFixed(2)}%`,
        valueNum: value,
        thresholdNum: cap,
        detail: decision.risk.breaches.find((breach) => /exposure|heat/i.test(breach)) ?? null,
      });
    }
  }

  // 8. Daily loss budget — from /state's budget.
  {
    const used = input.dailyLossUsedPct ?? null;
    if (used !== null) {
      const halted = input.halted === true;
      rows.push({
        id: "daily-loss",
        label: "Daily loss budget",
        pass: !halted && used < 100 - EPS,
        value: `${used.toFixed(0)}% used`,
        threshold: "< 100%",
        valueNum: used,
        thresholdNum: 100,
        detail: halted ? "Trading is halted until the next session." : null,
      });
    }
  }

  if (decision.armed) return rows;
  // Refused: failing rows first, stable within each group.
  const failing = rows.filter((row) => !row.pass);
  const passing = rows.filter((row) => row.pass);
  return [...failing, ...passing];
}

/** "x of y pass" for the pipeline's L4 node. */
export function gatePassCount(rows: GateRow[]): { pass: number; total: number } {
  return { pass: rows.filter((row) => row.pass).length, total: rows.length };
}

// ── the Command pipeline (L0–L6) ────────────────────────────────────────────

export type PipelineState = "ok" | "warn" | "block";

export interface PipelineNode {
  id: "L0" | "L1" | "L2" | "L3" | "L4" | "L5" | "L6";
  label: string;
  /** One short value line; "—" when the layer has nothing to report. */
  value: string;
  state: PipelineState;
  /** The current node: cyan underline + soft glow. */
  current: boolean;
}

export interface PipelineInputs {
  liveSymbols: number;
  selectedCount: number;
  mismatchSymbols: number;
  regime: RegimeRead | null;
  decision: AgentDecision | null;
  gateRows: GateRow[];
  openPositions: number;
}

/**
 * Derive the seven pipeline nodes.
 *
 * The current node is the FIRST failing (block) node, else L4 — the edge gate
 * is where a healthy pipeline's attention sits. Warn means "computing, but
 * thin" (a warming feed, a missing layer); block means "this layer refuses".
 */
export function buildPipeline(input: PipelineInputs): PipelineNode[] {
  const { decision, regime } = input;

  // L0 — Data.
  let l0State: PipelineState;
  const l0Value =
    input.selectedCount > 0 ? `${input.liveSymbols} of ${input.selectedCount} fresh` : "no markets";
  if (input.mismatchSymbols > 0 || (input.selectedCount > 0 && input.liveSymbols === 0)) l0State = "block";
  else if (input.selectedCount === 0 || input.liveSymbols < input.selectedCount) l0State = "warn";
  else l0State = "ok";

  // L1 — Regime.
  let l1State: PipelineState = "warn";
  let l1Value = "—";
  if (regime && regime.available) {
    const pct = regimeTopProbability(regime);
    l1Value = `${regimeStateLabel(regime.state) ?? "Regime"}${pct === null ? "" : ` ${Math.round(pct * 100)}%`}`;
    const direction = decision?.confluence.direction ?? "none";
    const side = direction === "up" ? regime.sides.buy : direction === "down" ? regime.sides.sell : null;
    l1State = side && !side.permit ? "block" : "ok";
  }

  // L2 — Alpha agents (the evidence ensemble on the legacy path).
  let l2State: PipelineState = "warn";
  let l2Value = "—";
  const evidence: EvidenceResult | null = decision?.evidence ?? null;
  if (evidence) {
    l2Value = `${evidence.agreeingFamilies} of ${evidence.totalFamilies} agree`;
    if (evidence.dissentingFamilies > evidence.agreeingFamilies) l2State = "block";
    else if (evidence.direction === "none" || evidence.agreeingFamilies * 2 < evidence.totalFamilies) l2State = "warn";
    else l2State = "ok";
  }

  // L3 — Meta-model (the probability the gate spends).
  let l3State: PipelineState = "warn";
  let l3Value = "—";
  const winProb = decision?.winProbability ?? decision?.monteCarlo?.winProbability ?? null;
  const lowerBound = decision?.sizingProbabilityLowerBound ?? null;
  if (winProb !== null && Number.isFinite(winProb)) {
    l3Value =
      lowerBound !== null && Number.isFinite(lowerBound)
        ? `${Math.round(winProb * 100)}% (LB ${Math.round(lowerBound * 100)}%)`
        : `${Math.round(winProb * 100)}%`;
    l3State = "ok";
  }

  // L4 — Edge gate.
  let l4State: PipelineState;
  let l4Value: string;
  if (!decision) {
    l4State = "warn";
    l4Value = "—";
  } else if (input.gateRows.length === 0) {
    l4State = "warn";
    l4Value = "no gates";
  } else {
    const counts = gatePassCount(input.gateRows);
    l4Value = `${counts.pass} of ${counts.total} pass`;
    l4State = decision.armed ? "ok" : "block";
  }

  // L5 — Execution (the order the plan would rest as).
  let l5State: PipelineState = "warn";
  let l5Value = "—";
  const orderLabel = triggerTypeLabel(decision?.plan?.triggerType);
  if (decision?.plan && orderLabel) {
    l5Value = orderLabel;
    l5State = "ok";
  } else if (decision?.plan) {
    l5Value = "Order armed";
    l5State = "ok";
  }

  // L6 — Position manager.
  const l6Value = `${input.openPositions} open`;
  const l6State: PipelineState = "ok";

  const nodes: PipelineNode[] = [
    { id: "L0", label: "L0 Data", value: l0Value, state: l0State, current: false },
    { id: "L1", label: "L1 Regime", value: l1Value, state: l1State, current: false },
    { id: "L2", label: "L2 Alpha agents", value: l2Value, state: l2State, current: false },
    { id: "L3", label: "L3 Meta-model", value: l3Value, state: l3State, current: false },
    { id: "L4", label: "L4 Edge gate", value: l4Value, state: l4State, current: false },
    { id: "L5", label: "L5 Execution", value: l5Value, state: l5State, current: false },
    { id: "L6", label: "L6 Position manager", value: l6Value, state: l6State, current: false },
  ];
  const firstFailing = nodes.findIndex((node) => node.state === "block");
  nodes[firstFailing >= 0 ? firstFailing : 4].current = true;
  return nodes;
}

// ── Opportunities rows ──────────────────────────────────────────────────────

export type OpportunityStateId = "armed" | "gate" | "warming" | "blocked" | "no-edge";

export interface OpportunityRow {
  symbol: string;
  assetClass: string;
  priceLabel: string;
  changePct: number | null;
  feed: FeedStatus;
  stateId: OpportunityStateId;
  stateLabel: string;
  /** "Trend up 71%" — null when the regime layer has nothing on this symbol. */
  regimeLabel: string | null;
  /** The scan's expectancy in R — the sort key; null when never scanned. */
  edgeR: number | null;
  selected: boolean;
}

const OPPORTUNITY_STATE: Record<OpportunityStateId, { label: string; tone: "good" | "neutral" | "warn" | "bad" }> = {
  armed: { label: "Armed", tone: "good" },
  gate: { label: "Gate", tone: "neutral" },
  warming: { label: "Warming", tone: "warn" },
  blocked: { label: "Blocked", tone: "bad" },
  "no-edge": { label: "No edge", tone: "neutral" },
};

export function opportunityTone(stateId: OpportunityStateId): "good" | "neutral" | "warn" | "bad" {
  return OPPORTUNITY_STATE[stateId].tone;
}

/**
 * Merge the live instruments (stream first — the caller has already applied
 * `stream ?? poll`), the scan results and the regime reads into the
 * Opportunities rows, sorted by edge descending. Symbols with no scan result
 * sort after every scanned symbol, then alphabetically — a stable, honest
 * order that never invents an edge.
 */
export function buildOpportunityRows(input: {
  instruments: Instrument[];
  scans: ScanRow[];
  regimes: RegimeRead[];
  selected: string;
}): OpportunityRow[] {
  const scanBySymbol = new Map(input.scans.map((row) => [row.symbol, row]));
  const regimeBySymbol = new Map(input.regimes.map((read) => [read.symbol, read]));
  const rows = input.instruments.map((instrument) => {
    const scan = scanBySymbol.get(instrument.symbol) ?? null;
    const regime = regimeBySymbol.get(instrument.symbol) ?? null;
    const stateId = opportunityStateId(instrument, scan);
    const pct = regimeTopProbability(regime);
    return {
      symbol: instrument.symbol,
      assetClass: instrument.assetClass,
      priceLabel: formatPrice(instrument.bid, instrument.digits),
      changePct: instrument.changePct,
      feed: instrument.dataStatus,
      stateId,
      stateLabel: OPPORTUNITY_STATE[stateId].label,
      regimeLabel:
        regime && regime.available
          ? `${regimeStateLabel(regime.state) ?? "Regime"}${pct === null ? "" : ` ${Math.round(pct * 100)}%`}`
          : null,
      edgeR: scan?.expectancyR ?? null,
      selected: instrument.symbol === input.selected,
    };
  });
  return rows.sort((a, b) => {
    const edgeA = a.edgeR ?? Number.NEGATIVE_INFINITY;
    const edgeB = b.edgeR ?? Number.NEGATIVE_INFINITY;
    if (edgeA !== edgeB) return edgeB - edgeA;
    return a.symbol.localeCompare(b.symbol);
  });
}

/** The row's state badge: blocked/warming feed outranks the scan's verdict. */
export function opportunityStateId(instrument: Instrument, scan: ScanRow | null): OpportunityStateId {
  if (instrument.dataStatus === "mismatch" || instrument.dataStatus === "stale") return "blocked";
  if (instrument.dataStatus === "warming") return "warming";
  if (scan?.armed) return "armed";
  if (scan && scan.rejections.length > 0) return "gate";
  return "no-edge";
}

export type OpportunityFilter = "all" | "armed" | "forex" | "other";

export function filterOpportunities(rows: OpportunityRow[], filter: OpportunityFilter): OpportunityRow[] {
  switch (filter) {
    case "armed": return rows.filter((row) => row.stateId === "armed");
    case "forex": return rows.filter((row) => row.assetClass === "forex");
    case "other": return rows.filter((row) => row.assetClass !== "forex");
    default: return rows;
  }
}

// ── Risk & safety rows ──────────────────────────────────────────────────────

export interface RiskMeterRow {
  id: string;
  label: string;
  /** Formatted value; "—" when the server has nothing. */
  value: string;
  /** The limit caption, e.g. "of $250 limit". */
  unit: string | null;
  /** 0..1+ for the meter; null ⇒ no meter (nothing measured). */
  fraction: number | null;
  tone: "good" | "warn" | "bad" | "neutral";
}

function meterTone(fraction: number | null, haltedOrBreach = false): "good" | "warn" | "bad" | "neutral" {
  if (fraction === null) return "neutral";
  if (haltedOrBreach || fraction >= 1) return "bad";
  if (fraction >= DESK_THRESHOLDS.nearLimitFraction) return "warn";
  return "good";
}

/**
 * The six Risk & safety rows, each a value against a limit the SERVER owns:
 * the daily-loss budget, the drawdown kill level, the exposure cap, the
 * loss-streak backstop and the rollout's slippage bar. A missing input yields
 * an em dash and no meter — never a zero that looks measured.
 */
export function buildRiskRows(input: {
  state: DeskStateResponse | null;
  /** v4 execution ledger (slippage EWMA); null when the endpoint is off. */
  slippageEwmaR: number | null;
}): RiskMeterRow[] {
  const { state } = input;
  const rows: RiskMeterRow[] = [];
  if (!state) {
    return [
      { id: "day", label: "Day result", value: "—", unit: null, fraction: null, tone: "neutral" },
      { id: "daily-loss", label: "Daily loss used", value: "—", unit: null, fraction: null, tone: "neutral" },
      { id: "drawdown", label: "Drawdown", value: "—", unit: null, fraction: null, tone: "neutral" },
      { id: "heat", label: "Open risk (heat)", value: "—", unit: null, fraction: null, tone: "neutral" },
      { id: "streak", label: "Loss streak", value: "—", unit: null, fraction: null, tone: "neutral" },
      { id: "slippage", label: "Slippage EWMA", value: "—", unit: null, fraction: null, tone: "neutral" },
    ];
  }
  const { risk, policy, account } = state;

  // Day result — the money number, no meter (it is not against a limit).
  const dayValue = risk.state.realisedPnlToday;
  rows.push({
    id: "day",
    label: "Day result",
    value: `${dayValue >= 0 ? "+" : "−"}${Math.abs(dayValue).toFixed(2)}`,
    unit: account?.currency ?? null,
    fraction: null,
    tone: dayValue > 0 ? "good" : dayValue < 0 ? "bad" : "neutral",
  });

  // Daily loss used, of the policy limit.
  const budget = risk.budget;
  if (budget) {
    const fraction = Math.max(0, budget.usedPct) / 100;
    rows.push({
      id: "daily-loss",
      label: "Daily loss used",
      value: `${Math.max(0, budget.usedPct).toFixed(0)}%`,
      unit: `of ${budget.limitMoney.toFixed(2)} limit`,
      fraction,
      tone: meterTone(fraction, risk.state.haltedUntilNextSession),
    });
  } else {
    rows.push({ id: "daily-loss", label: "Daily loss used", value: "—", unit: null, fraction: null, tone: "neutral" });
  }

  // Drawdown, of the kill level.
  const equity = account?.equity ?? null;
  const peak = account?.peakEquity ?? null;
  if (equity !== null && peak !== null && peak > 0) {
    const ddPct = Math.max(0, ((peak - equity) / peak) * 100);
    const limit = policy.maxDrawdownPct;
    const fraction = limit > 0 ? ddPct / limit : null;
    rows.push({
      id: "drawdown",
      label: "Drawdown",
      value: `${ddPct.toFixed(2)}%`,
      unit: `of ${limit.toFixed(1)}% kill level`,
      fraction,
      tone: meterTone(fraction),
    });
  } else {
    rows.push({ id: "drawdown", label: "Drawdown", value: "—", unit: "no peak stamped yet", fraction: null, tone: "neutral" });
  }

  // Open risk (heat), of the cap.
  const heat = openRiskPct(risk.exposure);
  const cap = policy.maxCurrencyExposurePct;
  rows.push({
    id: "heat",
    label: "Open risk (heat)",
    value: `${heat.toFixed(2)}%`,
    unit: `of ${cap.toFixed(2)}% cap`,
    fraction: cap > 0 ? heat / cap : null,
    tone: meterTone(cap > 0 ? heat / cap : null),
  });

  // Loss streak, against the backstop.
  const streak = risk.state.consecutiveLosses;
  const backstop = policy.haltAfterConsecutiveLosses;
  rows.push({
    id: "streak",
    label: "Loss streak",
    value: String(streak),
    unit: `vs ${backstop} backstop`,
    fraction: backstop > 0 ? streak / backstop : null,
    tone: meterTone(backstop > 0 ? streak / backstop : null, risk.state.haltedUntilNextSession),
  });

  // Slippage EWMA, against the rollout's bar.
  const ewma = input.slippageEwmaR;
  if (ewma !== null && Number.isFinite(ewma)) {
    const max = DESK_THRESHOLDS.slippageMaxR;
    rows.push({
      id: "slippage",
      label: "Slippage EWMA",
      value: `${ewma.toFixed(3)}R`,
      unit: `vs ${max.toFixed(2)}R max`,
      fraction: max > 0 ? Math.abs(ewma) / max : null,
      tone: meterTone(max > 0 ? Math.abs(ewma) / max : null),
    });
  } else {
    rows.push({ id: "slippage", label: "Slippage EWMA", value: "—", unit: "no stamped fills yet", fraction: null, tone: "neutral" });
  }

  return rows;
}

/** The Risk panel's header badge: Healthy / Near a limit / Halted. */
export function riskBadge(
  rows: RiskMeterRow[],
  halted: boolean,
): { label: "Healthy" | "Near a limit" | "Halted"; tone: "good" | "warn" | "bad" } {
  if (halted) return { label: "Halted", tone: "bad" };
  if (rows.some((row) => row.tone === "bad")) return { label: "Halted", tone: "bad" };
  if (rows.some((row) => row.tone === "warn")) return { label: "Near a limit", tone: "warn" };
  return { label: "Healthy", tone: "good" };
}

// ── alert strip ─────────────────────────────────────────────────────────────

export interface DeskAlert {
  id: string;
  tone: "rose" | "amber" | "sky";
  /** A short label for the chip on the left of the strip. */
  title: string;
  text: string;
}

/**
 * The alert strip's content, most severe first. The strip shows ONE alert;
 * the rest go behind "+N more". The copy is the v4 banners', verbatim where
 * they had one — a reworded alarm is a new claim.
 */
export function buildAlerts(input: {
  state: DeskStateResponse | null;
  mismatchedSymbols: string[];
  actionError: string | null;
  nowMs: number;
}): DeskAlert[] {
  const alerts: DeskAlert[] = [];
  const state = input.state;
  if (!state) return alerts;

  if (state.risk.state.haltedUntilNextSession) {
    alerts.push({
      id: "halt",
      tone: "rose",
      title: "Halted",
      text: state.risk.state.haltReason ?? "Trading is halted until the next session.",
    });
  }
  if (input.mismatchedSymbols.length > 0) {
    const many = input.mismatchedSymbols.length > 1;
    alerts.push({
      id: "mismatch",
      tone: "rose",
      title: "Feed mismatch",
      text:
        `${input.mismatchedSymbols.join(", ")} ${many ? "are" : "is"} reporting a price that disagrees with its own candles. ` +
        `Trading on ${many ? "them" : "it"} is blocked — check the broker symbol and that the EA is subscribed to it.`,
    });
  }
  const terminal = state.terminal;
  if (terminal?.stale) {
    const ageS = Math.max(0, Math.round((terminal.lastSyncAgeMs ?? input.nowMs - terminal.lastSyncAt) / 1000));
    const limitS = Math.round((terminal.staleAfterMs ?? 120_000) / 1000);
    alerts.push({
      id: "stale",
      tone: "amber",
      title: "MT5 stale",
      text:
        `The MT5 terminal has not synced for ${ageS}s (limit ${limitS}s). Quotes and agent entries are paused until it ` +
        "resumes; any displayed account snapshot is explicitly the last terminal update.",
    });
  }
  if (terminal?.degraded) {
    const ageS = Math.max(0, Math.round((terminal.lastSyncAgeMs ?? input.nowMs - terminal.lastSyncAt) / 1000));
    alerts.push({
      id: "reconnecting",
      tone: "sky",
      title: "Reconnecting",
      text:
        `Reconnecting to the MT5 terminal — last heartbeat ${ageS}s ago ` +
        `(it reports every ${terminal.syncIntervalMs ? `${(terminal.syncIntervalMs / 1000).toFixed(1)}s` : "~1s"}). ` +
        "The link is saved on both sides, so a closed terminal, a restart or a redeploy reconnects by itself. The desk " +
        "keeps analysing; every market is still gated on its own quote age, so nothing is traded on a stale price.",
    });
  }
  if (input.actionError) {
    alerts.push({ id: "action-error", tone: "amber", title: "Action failed", text: input.actionError });
  }
  return alerts;
}

// ── rollout stepper ─────────────────────────────────────────────────────────

/**
 * The rollout stage, derived from what the server reports — never stored:
 * shadow while v4 is off or globally shadowed, demo while the account (or the
 * policy) is not live, then the risk stage the policy's own base risk names.
 */
export function rolloutStage(input: {
  v4: DeskV4Summary | null | undefined;
  accountIsLive: boolean | null;
  liveTradingEnabled: boolean | null;
  baseRiskPct: number | null;
}): number {
  if (!input.v4 || !input.v4.enabled || input.v4.shadow) return 0;
  if (input.accountIsLive !== true || input.liveTradingEnabled !== true) return 1;
  const base = input.baseRiskPct;
  if (base === null || !Number.isFinite(base)) return 1;
  if (base <= 0.1) return 2;
  if (base <= 0.25) return 3;
  return 4;
}

/** "61 of 200 trades needed to leave demo" — the 200 is the exported constant. */
export function rolloutDemoNote(measuredTrades: number | null): string {
  const n = measuredTrades === null || !Number.isFinite(measuredTrades) ? 0 : Math.max(0, Math.floor(measuredTrades));
  return `${n} of ${DESK_THRESHOLDS.rolloutDemoMinTrades} trades needed to leave demo`;
}

export { ROLLOUT_STAGES };

// ── Learning workspace helpers ──────────────────────────────────────────────

/** The Learning tab's badge: how many agents are halved or disabled. */
export function governedAgentAlertCount(agents: { status: string }[]): number {
  return agents.filter((agent) => agent.status === "halved" || agent.status === "disabled").length;
}

/** The regime split bar's three parts, from the posterior's own labels. */
export function regimeSplit(read: RegimeRead | null | undefined): { trend: number; range: number; disorder: number } | null {
  if (!read || !read.available || !read.posterior) return null;
  const posterior = read.posterior;
  const trend = (posterior.trend_up ?? 0) + (posterior.trend_down ?? 0);
  const range = posterior.range ?? 0;
  const disorder = posterior.volatile ?? 0;
  const total = trend + range + disorder;
  if (total <= 0) return null;
  return { trend: trend / total, range: range / total, disorder: disorder / total };
}

/** "Buy ok · Sell no" — the regime's permits in words (colour is never alone). */
export function regimePermitLabel(read: RegimeRead | null | undefined): string | null {
  if (!read || !read.available) return null;
  const buy = read.sides.buy.permit ? "Buy ok" : "Buy no";
  const sell = read.sides.sell.permit ? "Sell ok" : "Sell no";
  return `${buy} · ${sell}`;
}

/** The Markets workspace's "next pass in N s", or null before the first pass. */
export function nextAutoSelectLabel(nextDueAt: number | null | undefined, nowMs: number): string | null {
  if (nextDueAt === null || nextDueAt === undefined || !Number.isFinite(nextDueAt)) return null;
  const seconds = Math.max(0, Math.round((nextDueAt - nowMs) / 1000));
  return seconds >= 60 ? `next pass in ${Math.floor(seconds / 60)}m` : `next pass in ${seconds}s`;
}

/** The Auto-select panel's summary sentence, from the record's own numbers. */
export function autoSelectSummary(last: {
  scanned: number;
  qualified: number;
  skipped: string[];
  reason: string;
} | null): string | null {
  if (!last) return null;
  const skipped =
    last.skipped.length > 0 ? ` - skipped ${last.skipped.length} (${last.skipped.join(", ")})` : "";
  return `Scanned ${last.scanned} - qualified ${last.qualified}${skipped}. ${last.reason}`;
}

/** Client-side CSV for the closed-trades export — from the loaded rows only. */
export function closedTradesCsv(rows: {
  closedAt: number;
  symbol: string;
  side: string;
  volume: number;
  agents?: string[] | null;
  rMultiple: number | null;
  profit: number;
  swap: number;
  commission: number;
}[]): string {
  const header = "closedAt,symbol,side,lots,agents,resultR,pnl";
  const lines = rows.map((row) => {
    const net = row.profit + row.swap + row.commission;
    return [
      new Date(row.closedAt).toISOString(),
      row.symbol,
      row.side,
      String(row.volume),
      (row.agents ?? []).join("|"),
      row.rMultiple === null ? "" : row.rMultiple.toFixed(3),
      net.toFixed(2),
    ].join(",");
  });
  return [header, ...lines].join("\n");
}
