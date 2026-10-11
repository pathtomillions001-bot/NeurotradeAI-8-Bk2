/**
 * WP10 — the desk's TIMEFRAME STATE, read cheaply enough for a UI to poll.
 *
 * The terminal already has a full decision endpoint (`GET /desk/analysis`), and it
 * is the wrong thing to call twice a second: it fits a regime model, prices a plan
 * and runs a Monte Carlo. What a dashboard needs is the regime READ — "which state
 * is this market in, how sure is the model, how long does it usually last, and has
 * something just changed" — without the plan.
 *
 * ── WHY THIS IS A CACHE AND NOT A SECOND IMPLEMENTATION ─────────────────────
 *
 * The read is built from the SAME functions the live permit uses
 * (`featuresFromBars` → `fitHmm` → `filterPosterior` → `expectedDwellOfLabel` →
 * `changeProbabilities`) and then asks `regimePermit` itself what each side would
 * be allowed to do, handing it the model that was just fitted. So the dashboard
 * cannot disagree with the desk: the number on the screen is the number the
 * gatekeeper's permit is about to apply.
 *
 * The TTL exists because the answer only changes when a bar closes. Two seconds is
 * the brief's ceiling for desk-timeframe staleness; the cache key includes the last
 * bar's open time, so a new bar always recomputes immediately, whatever the clock
 * says, and the reader is told how old its reading is (`ageMs`, `cached`).
 */
import { CLOSE } from "./math";
import { logReturns } from "./math";
import type { Bar, Timeframe, TradeMode } from "./types";
import { changeProbabilities } from "./change-point";
import {
  DEFAULT_REGIME_HMM_CONFIG,
  expectedDwellOfLabel,
  featuresFromBars,
  filterPosterior,
  fitHmm,
  regimePermit,
  type HmmModel,
  type RegimeHmmConfig,
  type RegimeState,
} from "./regime-hmm";

/** The brief's ceiling on desk-timeframe staleness, in milliseconds. */
export const REGIME_STATE_TTL_MS = 2_000;

/** How many (session, symbol, frame, window) reads are remembered. */
const REGIME_STATE_CACHE_LIMIT = 200;

export interface RegimeSideRead {
  required: RegimeState;
  probability: number;
  permit: boolean;
  codes: string[];
  reason: string;
}

export interface RegimeStateRead {
  symbol: string;
  frame: Timeframe;
  mode: TradeMode;
  /** The state the filtered posterior puts the most weight on. */
  state: RegimeState;
  /** P(label) for every label the model carries. */
  posterior: Record<string, number>;
  expectedDwellBars: number;
  changeProbability: number;
  /** Bars of history the fit consumed, and the fit's own diagnostics. */
  fit: {
    bars: number;
    iterations: number;
    logLikelihood: number;
    reused: boolean;
    adequate: boolean;
  };
  /** What the live permit would say for each direction, from the same model. */
  sides: { buy: RegimeSideRead; sell: RegimeSideRead };
  asOfMs: number;
  /** Milliseconds since this reading was computed. */
  ageMs: number;
  /** True when the reading came from the cache rather than a fresh fit. */
  cached: boolean;
  /** False when the window is too short to fit at all (all fields are defaults). */
  available: boolean;
  reason: string;
}

interface CacheEntry {
  read: RegimeStateRead;
  computedAtMs: number;
  /** The cache key that produced it, for the caller-facing `cached` flag. */
  key: string;
}

const cache = new Map<string, CacheEntry>();

/** Test-only: forget every memoised reading. */
export function resetRegimeStateCacheForTests(): void {
  cache.clear();
}

function unavailableRead(input: {
  symbol: string;
  frame: Timeframe;
  mode: TradeMode;
  asOfMs: number;
  reason: string;
}): RegimeStateRead {
  const side = (required: RegimeState): RegimeSideRead => ({
    required,
    probability: 0,
    permit: false,
    codes: ["REGIME_UNAVAILABLE"],
    reason: input.reason,
  });
  return {
    symbol: input.symbol,
    frame: input.frame,
    mode: input.mode,
    state: "range",
    posterior: {},
    expectedDwellBars: 0,
    changeProbability: 1,
    fit: { bars: 0, iterations: 0, logLikelihood: 0, reused: false, adequate: false },
    sides: { buy: side("trend_up"), sell: side("trend_down") },
    asOfMs: input.asOfMs,
    ageMs: 0,
    cached: false,
    available: false,
    reason: input.reason,
  };
}

/**
 * Read the desk's regime state for one symbol and frame.
 *
 * `nowMs` is passed in rather than read from the clock so the cache is testable and
 * so a caller replaying history can never be served a live reading.
 */
export function deskRegimeState(input: {
  sessionId: string;
  symbol: string;
  frame: Timeframe;
  mode: TradeMode;
  bars: Bar[];
  nowMs: number;
  config?: Partial<RegimeHmmConfig>;
  /** A model already fitted on this window (WP9's stored artifact), if any. */
  model?: HmmModel | null;
  /** Disable the memo (used by the study when it wants a cold read). */
  bypassCache?: boolean;
}): RegimeStateRead {
  const cfg = { ...DEFAULT_REGIME_HMM_CONFIG, ...input.config };
  const window = input.bars.slice(-Math.max(cfg.fitBars, cfg.windowBars));
  const last = window[window.length - 1];
  const key = [
    input.sessionId,
    input.symbol,
    input.frame,
    input.mode,
    cfg.fitBars,
    cfg.states,
    window.length,
    last ? (last[0] as number) : 0,
  ].join("|");
  const hit = cache.get(key);
  if (!input.bypassCache && hit && input.nowMs - hit.computedAtMs < REGIME_STATE_TTL_MS) {
    return { ...hit.read, ageMs: input.nowMs - hit.computedAtMs, cached: true };
  }

  const features = featuresFromBars(window, cfg);
  if (features.matrix.length < cfg.states * 5) {
    const read = unavailableRead({
      symbol: input.symbol,
      frame: input.frame,
      mode: input.mode,
      asOfMs: input.nowMs,
      reason: `Regime state unavailable: only ${features.matrix.length} usable bars of history (needs ${cfg.states * 5}).`,
    });
    return read;
  }

  let model: HmmModel;
  let reused = false;
  try {
    if (input.model) {
      model = input.model;
      reused = true;
    } else {
      model = fitHmm(features.matrix, cfg);
    }
  } catch (error) {
    return unavailableRead({
      symbol: input.symbol,
      frame: input.frame,
      mode: input.mode,
      asOfMs: input.nowMs,
      reason: `Regime model unavailable: ${error instanceof Error ? error.message : String(error)}.`,
    });
  }

  const filtered = filterPosterior(model, features.matrix);
  const posterior: Record<string, number> = {};
  for (let s = 0; s < model.states; s++) {
    const label = model.labels[s] ?? "range";
    posterior[label] = (posterior[label] ?? 0) + (filtered.last[s] as number);
  }
  const state = model.labels[filtered.last.indexOf(Math.max(...filtered.last))] ?? "range";
  const returns = logReturns(window.map((bar) => bar[CLOSE])).filter((r) => Number.isFinite(r));
  const change = changeProbabilities(returns, {
    recentBars: cfg.changeRecentBars,
    config: { expectedRunLength: Math.max(50, cfg.windowBars / 2), maxRunLength: Math.max(50, cfg.windowBars / 2) },
  });
  const expectedDwellBars = expectedDwellOfLabel(model, state, filtered.last);

  // One fit, two permits: the model is handed back to `regimePermit`, so the
  // dashboard's permission and the gatekeeper's are the same computation.
  const permitFor = (side: "buy" | "sell"): RegimeSideRead => {
    const permit = regimePermit({
      bars: window,
      mode: input.mode,
      side,
      config: cfg,
      model,
    });
    return {
      required: permit.required,
      probability: permit.probability,
      permit: permit.permit,
      codes: permit.codes,
      reason: permit.reason,
    };
  };

  const read: RegimeStateRead = {
    symbol: input.symbol,
    frame: input.frame,
    mode: input.mode,
    state,
    posterior,
    expectedDwellBars,
    changeProbability: change.changeProbability,
    fit: {
      bars: features.matrix.length,
      iterations: model.iterations,
      logLikelihood: model.logLikelihood,
      reused,
      adequate: features.matrix.length >= cfg.fitBars,
    },
    sides: { buy: permitFor("buy"), sell: permitFor("sell") },
    asOfMs: input.nowMs,
    ageMs: 0,
    cached: false,
    available: true,
    reason: `State ${state} at ${(posterior[state] ?? 0).toFixed(3)} — expected dwell ${expectedDwellBars.toFixed(1)} bars, P(change) ${change.changeProbability.toFixed(3)}.`,
  };

  if (cache.size >= REGIME_STATE_CACHE_LIMIT) {
    // Bounded like every other memo in the desk: the oldest entry goes first.
    const oldest = [...cache.entries()].sort((a, b) => a[1].computedAtMs - b[1].computedAtMs)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { read, computedAtMs: input.nowMs, key });
  return read;
}
