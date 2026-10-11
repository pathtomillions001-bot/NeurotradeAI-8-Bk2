/**
 * The view builder — one evaluation, one `MetaView`.
 *
 * WP5's study walks a series and needs a view at every decision bar; the live
 * desk needs the very same view at exactly one bar: the last closed one. Those
 * two requirements must not be served by two implementations, or the model would
 * be fitted on features computed one way and spent on features computed another —
 * the classic silent train/serve skew. This file is the single implementation,
 * and `research/meta-eval.ts` is its first caller.
 *
 * Everything here is causal: the view at bar `i` is built from bars `0..i` and
 * nothing else, the quote is the decision bar's own close plus the spec's spread,
 * and the regime reading comes from a bounded trailing window. The agent cache is
 * the caller's, so a study can amortise work across bars without ever letting a
 * later bar leak into an earlier view.
 */
import { readAlphaAgents, buildAlphaAgents, type AlphaAgent, type AlphaContext, type AlphaId } from "../alpha";
import { defaultAllowlistForMode } from "../desk-v4-config";
import { assessRegime } from "../regime";
import { CLOSE, HIGH, LOW } from "../math";
import type { MetaView } from "./dataset";
import type { RegimeKind } from "../regime";
import type { Bar, SymbolSpec, Timeframe, TradeMode } from "../types";

export interface MetaViewInput {
  symbol: string;
  mode: TradeMode;
  spec: SymbolSpec;
  frame: Timeframe;
  /** Closed bars, oldest first. Bar `index` is the decision bar. */
  bars: Bar[];
  index: number;
  frameWidthMs: number;
  /** Trailing window the regime reading is taken over (default 200 bars). */
  regimeWindowBars?: number;
  /** The mode's own reference policy: which agents may propose. */
  allowlist?: readonly string[];
  /** WP3's P(change point), when the caller has it. */
  changeProbability?: number | null;
  agents?: Record<AlphaId, AlphaAgent>;
  /** Shared across bars by a study; must never carry state across views. */
  cache?: Map<string, unknown>;
  targetMultipleR: number;
  horizonBars: number;
  /**
   * The previous DECISION bar's reading, for the streak feature.
   *
   * The streak is defined as "consecutive decision bars whose regime reading has
   * not changed" — the same definition the WP5 study used, so a model fitted on
   * the study's features sees the same numbers live. Callers must update it at
   * EVERY decision bar, passing `kind: null` for a bar at which no agent fired:
   * an abstention breaks the streak. Omit it for a standalone bar and the streak
   * is 1, which is what the study records for the first view of every series.
   */
  previous?: { index: number; kind: RegimeKind | null; streak: number } | null;
}

export interface MetaViewAt {
  view: MetaView;
  /** The interpreted regime reading, for the caller's streak bookkeeping. */
  kind: RegimeKind | null;
  streak: number;
}

const MIN_REGIME_WINDOW_BARS = 20;

/**
 * Build the view at one bar, or null when no agent had anything to say.
 *
 * A null is not a failure: an abstention is information, and the caller decides
 * whether it means "no trade" (the live desk) or "no row" (the study).
 */
export function metaViewAt(input: MetaViewInput): MetaViewAt | null {
  const { bars, index, mode, spec, symbol, frame } = input;
  if (index < 0 || index >= bars.length) return null;
  const bar = bars[index] as Bar;
  const visible = bars.slice(0, index + 1);
  const now = (bar[0] as number) + input.frameWidthMs;
  const close = bar[CLOSE] as number;
  const agents = input.agents ?? buildAlphaAgents();

  const readings = readAlphaAgents(
    {
      symbol,
      mode,
      spec,
      series: { [frame]: visible } as Partial<Record<Timeframe, Bar[]>>,
      quote: {
        symbol,
        bid: close,
        ask: close + spec.spreadPoints * spec.point,
        spreadPoints: spec.spreadPoints,
        ts: now,
        ageMs: 100,
      },
      now,
      cache: input.cache,
    } satisfies AlphaContext,
    agents,
  );

  const firing = readings.filter((reading) => reading.view !== null);
  if (firing.length === 0) return null;

  const window = bars.slice(Math.max(0, index - Math.max(60, input.regimeWindowBars ?? 200) + 1), index + 1);
  const assessment =
    window.length >= MIN_REGIME_WINDOW_BARS ? assessRegime(window) : null;
  const kind = assessment ? assessment.kind : null;
  const previous = input.previous ?? null;
  // The streak is defined over CONSECUTIVE DECISION BARS: a bar at which no agent
  // fired breaks it, because the regime history the model was fitted on is the
  // history of decisions, not of views. `previous.kind === null` therefore means
  // "the previous decision bar had no reading", and the streak restarts at 1.
  const streak =
    previous !== null && previous.kind !== null && previous.kind === kind ? previous.streak + 1 : 1;

  const buys = firing.filter((reading) => reading.view?.direction === "buy").length;
  const sells = firing.length - buys;
  const direction: 1 | -1 =
    buys === sells ? (bestProbability(firing) >= 0.5 ? 1 : -1) : buys > sells ? 1 : -1;
  const agreeing = firing.filter(
    (reading) => (direction === 1 ? reading.view?.direction === "buy" : reading.view?.direction === "sell"),
  );
  const agentProbabilities: Record<string, number> = {};
  for (const reading of firing) agentProbabilities[reading.id] = reading.view?.probability ?? 0.5;
  const meanProbability =
    agreeing.reduce((sum, reading) => sum + (reading.view?.probability ?? 0.5), 0) / Math.max(1, agreeing.length);
  const allowlist = input.allowlist ?? defaultAllowlistForMode(mode);

  return {
    view: {
      index,
      direction,
      probability: meanProbability,
      agents: agreeing.map((reading) => reading.id),
      agentProbabilities,
      emitted: agreeing.some((reading) => allowlist.includes(reading.id)),
      mode,
      regimeKind: kind,
      regimeStreakBars: streak,
      changeProbability: input.changeProbability ?? null,
      targetMultipleR: input.targetMultipleR,
      horizonBars: input.horizonBars,
    },
    kind,
    streak,
  };
}

/**
 * The best probability among the firing agents.
 *
 * The floor is ZERO, not 0.5, and the difference is not cosmetic: the tie-break
 * for a bar where the same number of agents fired either way is
 * `bestProbability >= 0.5 ? long : short`, so a floor of 0.5 would turn every
 * uninformative tie into a LONG. That is a directional bias injected by a
 * helper function. The WP5 corpus was built with the zero floor and this
 * function reproduces it exactly — `meta-eval`'s stored report is the proof.
 */
function bestProbability(firing: { view: { probability: number } | null }[]): number {
  return firing.reduce((best, reading) => Math.max(best, reading.view?.probability ?? 0), 0);
}

/** Re-exported so a caller can pre-build the agent registry once per series. */
export { buildAlphaAgents };
export type { AlphaAgent, AlphaId };
export { HIGH, LOW };
