/**
 * Multi-Asset Desk — presentation helpers shared by the HTTP routes and the
 * live stream.
 *
 * The browser and the SSE channel must never disagree about a symbol's
 * status, so both are built from the same functions here. Anything that needs
 * to know whether a quote is fresh, sane or stale goes through feedHealth().
 */

import { closes } from "./math";
import { feedHealth, type FeedStatus } from "./integrity";
import { terminalIsFresh } from "./live";
import { seriesFor, type DeskState } from "./store";
import { MIN_COST_COVERAGE, MIN_RR_FILL } from "./desk-constants";
import type { AssetClass, Position, Timeframe } from "./types";

/** Timeframe used for the 24-hour high/low and the change percentage. */
const REFERENCE_TIMEFRAME: Timeframe = "M5";
/** Bars of reference timeframe that make up roughly 24 hours. */
const DAY_BARS = 288;
/** Points in the mini sparkline shown on compact layouts. */
const SPARKLINE_POINTS = 40;

export interface DeskInstrument {
  symbol: string;
  description: string;
  assetClass: AssetClass;
  digits: number | null;
  bid: number | null;
  ask: number | null;
  spreadPoints: number | null;
  changePct: number | null;
  watched: true;
  dataStatus: FeedStatus;
  lastQuoteAt: number | null;
  /** Milliseconds since this tick was taken, skew-corrected. */
  quoteAgeMs: number | null;
  /** Non-null when the quote disagrees with the symbol's own candles. */
  priceWarning: string | null;
  /** How far the quote sits from the last bar close, as a percentage. */
  deviationPct: number | null;
  /** Rolling 24h extremes from the broker's own bars. */
  sessionHigh: number | null;
  sessionLow: number | null;
  /** Recent closes for a sparkline. Empty when there is no history yet. */
  sparkline: number[];
  contractSize: number | null;
  point: number | null;
}

function pickSeries(desk: DeskState, symbol: string, timeframe: Timeframe) {
  return seriesFor(desk, symbol)[timeframe] ?? [];
}

export function quoteSnapshot(desk: DeskState, now = Date.now()): DeskInstrument[] {
  return desk.watchlist.map((symbol) => {
    const catalog = desk.catalog.get(symbol);
    const spec = desk.specs.get(symbol);
    const quote = desk.quotes.get(symbol);
    const health = feedHealth(desk, symbol, now);

    const bars = pickSeries(desk, symbol, REFERENCE_TIMEFRAME);
    const day = bars.slice(-DAY_BARS);
    let sessionHigh: number | null = null;
    let sessionLow: number | null = null;
    for (const bar of day) {
      const high = bar[2];
      const low = bar[3];
      if (high > 0 && (sessionHigh === null || high > sessionHigh)) sessionHigh = high;
      if (low > 0 && (sessionLow === null || low < sessionLow)) sessionLow = low;
    }

    const series = day.length > 0 ? day : bars;
    const first = series.length > 0 ? series[0][4] : null;
    const last = series.length > 0 ? series[series.length - 1][4] : null;
    const changePct = first && last ? ((last - first) / first) * 100 : null;

    return {
      symbol,
      description: catalog?.description ?? symbol,
      assetClass: catalog?.assetClass ?? spec?.assetClass ?? "other",
      digits: spec?.digits ?? null,
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      spreadPoints: quote?.spreadPoints ?? null,
      changePct,
      watched: true as const,
      dataStatus: health.status,
      lastQuoteAt: quote?.ts ?? null,
      quoteAgeMs: health.ageMs,
      priceWarning: health.status === "mismatch" ? health.detail : null,
      deviationPct: health.deviationPct,
      sessionHigh,
      sessionLow,
      sparkline: closes(bars).slice(-SPARKLINE_POINTS),
      contractSize: spec?.contractSize ?? null,
      point: spec?.point ?? null,
    };
  });
}

/**
 * The compact payload pushed over SSE on every heartbeat.
 *
 * Deliberately small: it is sent once per second per browser, so it carries
 * prices, status and warnings — nothing that can be fetched on demand.
 *
 * IMPORTANT: the `stale` flag must use the SAME adaptive window as the REST
 * `/state` endpoint (`terminalIsFresh` from live.ts). The previous hardcoded
 * 30 s check caused the SSE stream to report `stale: true` while the REST
 * API said the terminal was fine — the browser's mode buttons, auto-trade
 * toggle and analysis queries all gate on this field, so the disagreement
 * froze the entire Desk the moment one heartbeat was 31 s late.
 */
export function deskSummary(desk: DeskState, now = Date.now()) {
  return {
    serverTime: now,
    mode: desk.mode,
    autoTrade: desk.autoTrade,
    terminal: desk.terminal
      ? {
          login: desk.terminal.login,
          lastSyncAt: desk.terminal.lastSyncAt,
          stale: !terminalIsFresh(desk, now),
          degraded: now - desk.terminal.lastSyncAt > 20_000 && terminalIsFresh(desk, now),
        }
      : null,
    account: desk.account,
    instruments: quoteSnapshot(desk, now),
    positions: desk.positions.map(withManagementState),
    plans: [...desk.plans.values()],
    clockSkewMs: desk.clockSkewMs,
    lastQuoteAgeMs: desk.lastQuoteAgeMs,
  };
}

// ── v5 UI: small derived fields, all pure, all optional on the wire ─────────

/**
 * The management state of a position, as far as the wire data honestly shows.
 *
 * The WP0 state machine runs in the EA, and the heartbeat carries no state
 * field — so the server does NOT claim to know "partial" or "runner". What it
 * can state without inventing anything is geometry: a stop that sits at or
 * beyond the entry has removed the position's initial risk, which is exactly
 * what "breakeven armed" means. Everything else stays `"open"`, and the UI
 * renders only these two words (an absent state shows no badge at all).
 */
export type PositionManagementState = "open" | "be";

export function positionManagementState(position: Position): PositionManagementState {
  if (position.sl === null || !(position.sl > 0)) return "open";
  if (position.side === "buy") return position.sl >= position.openPrice ? "be" : "open";
  return position.sl <= position.openPrice ? "be" : "open";
}

/** Attach the derived state without disturbing any other field. */
export function withManagementState<T extends Position>(
  position: T,
): T & { managementState: PositionManagementState } {
  return { ...position, managementState: positionManagementState(position) };
}

/**
 * The scanner's edge columns, derived only from what the decision carries.
 *
 * `monteCarlo.rewardRisk` IS the reward:risk at the expected fill (agent.ts
 * §5a), so it is reported as `rrFill` without recomputation. The edge floor is
 * the gatekeeper's EV at p_LCB and the floor it was measured against; both are
 * null whenever the gatekeeper did not decide (v4 off) — a null renders as an
 * em dash, never as zero.
 */
export function scanEdgeFields(decision: {
  monteCarlo: { rewardRisk: number } | null;
  gatekeeper: { evLcbR: number | null; requiredEvLcbR: number } | null;
}): { rrFill: number | null; edgeFloorR: number | null; edgeRequiredR: number | null } {
  return {
    rrFill: decision.monteCarlo ? Number(decision.monteCarlo.rewardRisk.toFixed(2)) : null,
    edgeFloorR:
      decision.gatekeeper && decision.gatekeeper.evLcbR !== null
        ? Number(decision.gatekeeper.evLcbR.toFixed(3))
        : null,
    edgeRequiredR: decision.gatekeeper ? Number(decision.gatekeeper.requiredEvLcbR.toFixed(3)) : null,
  };
}

/**
 * The gate constants the Decision panel prints when the gatekeeper is not the
 * decider (the shipped, v4-off path). Served as an OPTIONAL `thresholds` block
 * on `GET /desk/analysis` so the UI never hard-codes a threshold the server
 * owns — these two numbers live in `desk-constants.ts` and nowhere else.
 */
export function analysisThresholds(): { minRrFill: number; minCostCoverage: number } {
  return { minRrFill: MIN_RR_FILL, minCostCoverage: MIN_COST_COVERAGE };
}
