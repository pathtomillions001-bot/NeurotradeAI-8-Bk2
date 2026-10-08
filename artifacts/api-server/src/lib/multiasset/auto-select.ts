/**
 * Multi-Asset Desk — automatic best-market selection.
 *
 * WHAT THIS IS
 *
 * With auto-trade on, the desk does not wait for the user to click a symbol.
 * On the terminal's own heartbeat it analyses the markets the user selected,
 * ranks the ones that pass EVERY gate (risk, news, quality, evidence
 * agreement, expectancy after costs, sizing), and arms the single best of them.
 * The EA then does the rest: it watches the trigger locally, opens the
 * position, and manages it from the plan's `management` block (break-even once,
 * a conditional target extension for intraday and swing, and a time stop) exactly
 * as it does for a manually armed plan. The EA enforces only those three.
 *
 * WHAT IT IS NOT
 *
 *   • Not a second risk model. Every candidate is scored by the same
 *     `evaluate()` the manual path uses, against the same account, the same
 *     risk state, the same news gate and the same cost policy. If the governor
 *     would refuse the trade for the user, it refuses it here.
 *   • Not a trade-count engine. There is no "one setup per symbol forever":
 *     a symbol that already has an armed plan or an open position is skipped
 *     so the pass looks for the best market that is not already committed,
 *     and the binding limits stay risk-based (positions, exposure, daily loss).
 *   • Not unbounded work. A pass evaluates a bounded window of the watchlist
 *     and rotates that window between passes, so a 200-symbol selection is
 *     covered over several passes instead of blocking the heartbeat.
 *
 * WHY IT REPORTS
 *
 * "Why is it not trading?" is the question this desk gets asked most. Every
 * pass records what it saw: how many markets were scanned, which qualified,
 * which was chosen and — when nothing qualified — the rejection that came
 * closest, with the runner-up table. That record is shown on the desk and
 * written to the journal (rate-limited), so the answer is always inspectable.
 */

import { evaluate, type AgentDecision } from "./agent";
import { MODE_MIN_AGREEING_FAMILIES } from "./evidence";
import { resolveLiveSymbol, terminalIsFresh } from "./live";
import { armPlan, journal, outcomesFor, type AutoSelectRecord, type DeskState } from "./store";
import type { TradeMode } from "./types";

/** How often a pass may run, per mode. Risk limits — not this timer — are the throttle on trading. */
export const AUTO_SELECT_INTERVAL_MS: Record<TradeMode, number> = {
  scalp: 15_000,
  intraday: 30_000,
  swing: 60_000,
};

/** Markets evaluated in a single pass; the window rotates between passes. */
export const AUTO_SELECT_MAX_CANDIDATES = 16;

/** Minimum spacing between "nothing qualified" journal notes. */
export const AUTO_SELECT_NOTE_INTERVAL_MS = 5 * 60_000;

/** Ranked candidates retained on the record for display. */
const MAX_RANKED_ROWS = 6;

export interface AutoSelectOutcome {
  record: AutoSelectRecord;
  /** The plan that was armed this pass, if any. */
  armedSymbol: string | null;
  /** Decisions examined, for callers that need the detail (tests, tooling). */
  decisions: AgentDecision[];
}

/** True when a pass is due for this desk. */
export function autoSelectDue(desk: DeskState, now = Date.now()): boolean {
  if (!desk.autoTrade) return false;
  if (!desk.terminal || !terminalIsFresh(desk, now)) return false;
  if (!desk.account) return false;
  if (desk.riskState.haltedUntilNextSession) return false;
  if (desk.watchlist.length === 0) return false;
  return now - desk.lastAutoSelectAt >= AUTO_SELECT_INTERVAL_MS[desk.mode];
}

function hasOpenPosition(desk: DeskState, symbol: string): boolean {
  return desk.positions.some((position) => position.symbol === symbol);
}

function hasArmedPlan(desk: DeskState, symbol: string): boolean {
  for (const plan of desk.plans.values()) {
    if (plan.symbol === symbol) return true;
  }
  return false;
}

/**
 * The markets a pass may consider: selected, fresh-looking, and not already
 * committed. Returned as a rotated window so successive passes sweep the whole
 * selection.
 */
export function autoSelectCandidates(desk: DeskState): string[] {
  const eligible = desk.watchlist.filter(
    (symbol) => !hasOpenPosition(desk, symbol) && !hasArmedPlan(desk, symbol),
  );
  if (eligible.length <= AUTO_SELECT_MAX_CANDIDATES) {
    desk.autoSelectCursor = 0;
    return eligible;
  }
  const start = desk.autoSelectCursor % eligible.length;
  const window: string[] = [];
  for (let i = 0; i < AUTO_SELECT_MAX_CANDIDATES; i++) {
    window.push(eligible[(start + i) % eligible.length] as string);
  }
  desk.autoSelectCursor = (start + AUTO_SELECT_MAX_CANDIDATES) % eligible.length;
  return window;
}

/** Ranking: expectancy after costs first — it is what the gate enforces. */
function betterThan(a: AgentDecision, b: AgentDecision): boolean {
  const aEdge = a.expectancyR ?? Number.NEGATIVE_INFINITY;
  const bEdge = b.expectancyR ?? Number.NEGATIVE_INFINITY;
  if (aEdge !== bEdge) return aEdge > bEdge;
  if (a.qualityScore !== b.qualityScore) return a.qualityScore > b.qualityScore;
  return a.symbol < b.symbol;
}

/**
 * How close a candidate came to being tradable — for the "nothing qualified"
 * report.
 *
 * WHY THIS IS NOT JUST `decisions[0]`
 *
 * The old code named the FIRST market it had scanned as the "closest" miss,
 * which is a statement about the watchlist order, not about the market. That is
 * how a report could read:
 *
 *     Closest: EURUSD.m — Quality 36.9 is below the 60.0 required
 *     US30.std  A+  83   Expectancy after costs is -0.71R … below the minimum
 *
 * i.e. it pointed at a setup that failed the QUALITY gate by 23 points while an
 * A+ setup failed only the expectancy gate. The user is right to call that
 * broken: the named candidate must be the one that would trade if one gate
 * were relaxed.
 *
 * The rule below is therefore two-tiered:
 *
 *   1. setups that cleared every *analysis* gate (direction, quality, evidence
 *      agreement) but lost on economics — ranked by expectancy, because that is
 *      the gate that stopped them and the number that has to improve;
 *   2. everything else — ranked by quality, because those never got as far as
 *      having a meaningful expectancy.
 */
function analysisTier(decision: AgentDecision): 0 | 1 {
  return analysisSurvivor(decision) ? 0 : 1;
}

/** True when every gate except the economics was satisfied. */
function analysisSurvivor(decision: AgentDecision): boolean {
  if (decision.confluence.direction === "none") return false;
  if (decision.qualityScore < decision.qualityThreshold) return false;
  if (
    decision.evidence &&
    decision.evidence.direction !== "none" &&
    decision.evidence.agreeingFamilies < MODE_MIN_AGREEING_FAMILIES[decision.mode]
  ) {
    return false;
  }
  if (decision.news.blocked) return false;
  if (!decision.risk.allow) return false;
  if (decision.monteCarlo === null) return false;
  return true;
}

/** Closest-miss ordering: analysis survivors first, then best quality. */
function closerThan(a: AgentDecision, b: AgentDecision): boolean {
  const tierA = analysisTier(a);
  const tierB = analysisTier(b);
  if (tierA !== tierB) return tierA < tierB;
  if (tierA === 0) return betterThan(a, b);
  if (a.qualityScore !== b.qualityScore) return a.qualityScore > b.qualityScore;
  return a.symbol < b.symbol;
}

/**
 * Run one automatic best-market pass.
 *
 * Returns null when the pass could not run at all (auto-trade off, stale
 * terminal, halted session, empty selection); a record with `chosen: null`
 * when it ran and nothing qualified.
 */
export function runAutoSelect(desk: DeskState, now = Date.now()): AutoSelectOutcome | null {
  if (!desk.autoTrade) return null;
  if (!desk.terminal || !terminalIsFresh(desk, now)) return null;
  if (!desk.account) return null;
  if (desk.riskState.haltedUntilNextSession) return null;
  if (desk.watchlist.length === 0) return null;

  const mode = desk.mode;
  const candidates = autoSelectCandidates(desk);
  const decisions: AgentDecision[] = [];
  /** Named so the report never has to say "no data" without saying WHERE. */
  const skipped: string[] = [];
  let available = 0;

  for (const symbol of candidates) {
    const resolved = resolveLiveSymbol(desk, symbol, now);
    // A symbol that is warming, stale or quoting a price that disagrees with
    // its own candles is skipped, never analysed.
    if (!resolved || !desk.account) {
      skipped.push(symbol);
      continue;
    }
    available++;
    try {
      decisions.push(
        evaluate({
          symbol,
          mode,
          spec: resolved.spec,
          quote: resolved.quote,
          series: resolved.series,
          account: desk.account,
          positions: desk.positions,
          specs: desk.specs,
          riskState: desk.riskState,
          policy: desk.policy,
          news: desk.news,
          outcomes: outcomesFor(desk, symbol, mode),
          now,
        }),
      );
    } catch (error) {
      // One malformed market must never stop the pass for the others.
      journal(desk, "no_trade", symbol, `Auto-select skipped ${symbol}: ${(error as Error).message}`);
    }
  }

  const qualified = decisions.filter((decision) => decision.armed && decision.plan);
  qualified.sort((a, b) => (betterThan(a, b) ? -1 : betterThan(b, a) ? 1 : 0));

  // Closest-first for the table as well, so the row the desk names in its
  // reason is the row at the top of the scan list.
  const ranked = [...decisions]
    .sort((a, b) => (closerThan(a, b) ? -1 : closerThan(b, a) ? 1 : 0))
    .slice(0, MAX_RANKED_ROWS)
    .map((decision) => ({
      symbol: decision.symbol,
      expectancyR: decision.expectancyR,
      score: Number(decision.qualityScore.toFixed(1)),
      grade: decision.confluence.grade,
      armed: decision.armed,
    }));

  const winner = qualified[0];
  /**
   * Named in both branches: an armed report that hides the markets it could not
   * even look at reads exactly like the pass was broken. Formatting lives here
   * so the armed and empty branches cannot drift apart.
   */
  const skippedNote =
    skipped.length === 0
      ? ""
      : ` ${skipped.length} had no fresh, self-consistent data and were skipped: ` +
        `${skipped.slice(0, 4).join(", ")}${skipped.length > 4 ? ` and ${skipped.length - 4} more` : ""}.`;
  let record: AutoSelectRecord;

  if (winner?.plan) {
    armPlan(desk, winner.plan);
    desk.planModes.set(winner.symbol, winner.plan.mode);
    const runnersUp = qualified.slice(1, 3).map((decision) => decision.symbol).join(", ");
    record = {
      at: now,
      mode,
      scanned: available,
      qualified: qualified.length,
      chosen: winner.symbol,
      skipped,
      reason:
        `Best of ${available} selected market${available === 1 ? "" : "s"}: ${winner.symbol} ` +
        `${winner.plan.side.toUpperCase()} ${winner.plan.lots} lots — ` +
        `quality ${winner.qualityScore.toFixed(1)}, E ${(winner.expectancyR ?? 0).toFixed(2)}R, ` +
        `${(winner.winProbability ?? 0) * 100 > 0 ? `${((winner.winProbability ?? 0) * 100).toFixed(0)}% win` : "win n/a"}` +
        (runnersUp ? `. Runners-up: ${runnersUp}.` : ".") +
        skippedNote,
      ranked,
    };
    desk.lastAutoSelect = record;
    desk.lastAutoSelectNoteAt = now;
    journal(desk, "signal", winner.symbol, `Auto-select armed the best of ${available}: ${record.reason}`, {
      planId: winner.plan.id,
      rejections: winner.rejections,
      ranked,
    });
    return { record, armedSymbol: winner.symbol, decisions };
  }

  // Nothing qualified. Name the CLOSEST miss — the setup that would have traded
  // if one gate were relaxed — never simply the first market scanned.
  const closest = [...decisions].sort((a, b) => (closerThan(a, b) ? -1 : closerThan(b, a) ? 1 : 0))[0];
  const closestGrade = closest ? `${closest.confluence.grade}, quality ${closest.qualityScore.toFixed(0)}` : "";
  const reason = closest
    ? `No qualifying setup in ${available} selected market${available === 1 ? "" : "s"}.${skippedNote} ` +
      `Closest: ${closest.symbol} (${closestGrade}) — ${closest.rejections[0] ?? closest.sizing?.explanation ?? "quality below threshold."}`
    : `No selected market has fresh, self-consistent data to analyse yet.${skippedNote}`;

  record = {
    at: now,
    mode,
    scanned: available,
    qualified: 0,
    chosen: null,
    reason,
    skipped,
    ranked,
  };
  desk.lastAutoSelect = record;

  if (now - desk.lastAutoSelectNoteAt >= AUTO_SELECT_NOTE_INTERVAL_MS) {
    desk.lastAutoSelectNoteAt = now;
    journal(desk, "no_trade", closest?.symbol ?? null, `Auto-select: ${reason}`, {
      ranked,
      rejections: closest?.rejections ?? [],
    });
  }
  return { record, armedSymbol: null, decisions };
}

/**
 * Throttled entry point for the heartbeat path.
 *
 * Returns the record only when a pass actually ran, so callers can push a
 * stream update without doing work on every beat.
 */
export function maybeAutoSelect(desk: DeskState, now = Date.now()): AutoSelectOutcome | null {
  if (!autoSelectDue(desk, now)) return null;
  desk.lastAutoSelectAt = now;
  return runAutoSelect(desk, now);
}
