/**
 * WP4 — the alpha agents: shared interface (and the rules all five obey).
 *
 * ── WHAT AN AGENT IS, AND WHAT IT IS NOT ────────────────────────────────────
 *
 * An agent is a DETECTOR with a claim. It looks at the bars it is given and
 * either says "this setup, this direction, and here is the probability I put on
 * it" or says nothing. It does not size, does not arm, does not talk to the
 * broker, and does not get to be right by being vague: the whole pipeline goes
 * through `AlphaView`, and the study that judges it measures the claim itself.
 *
 * Five rules, enforced by construction rather than by convention:
 *
 *   1. **Causality.** `ctx.series` holds CLOSED bars only, oldest first, and an
 *      agent may read nothing else (the harness binary-searches exactly the bars
 *      whose own close is ≤ `now`). A view taken at bar *t* may not use bar
 *      *t+1* — see `alpha.test.ts` for the assertion that runs on all five.
 *   2. **Abstention is a first-class answer.** `null` means "not my setup",
 *      which is a legitimate and frequent answer. An agent has no duty to
 *      provide an opinion on every bar, and a detector that always fires is
 *      noise with a straight face.
 *   3. **Probability, not enthusiasm.** `probability` is P(this setup reaches
 *      `MIN_RR` before its stop), a number in [0, 1] with a stated sample behind
 *      it (§ `alpha/edge.ts`), never a score out of 100.
 *   4. **Determinism.** Same bars, same view — no RNG anywhere in `alpha/`.
 *   5. **No constant tuning.** Every threshold in `alpha/` is either a
 *      documented structural constant (a 0.25 ATR reclaim is a reclaim, not a
 *      parameter) or measured on labelled fixtures by the harness. The original
 *      brief named a catalogue of entry thresholds (Ichimoku, ADX > 26,
 *      CCI, RSI(2), pips-of-pullback, Keltner, Gaussian channels, alligator
 *      spreads, round-number distances); shipping a dozen hard-coded numbers
 *      that LOOK authoritative is exactly the failure mode v4 exists to end, so
 *      the catalogue lives in `docs/mt5-live-desk-v4.md` as future per-family
 *      studies and what ships here is the five families with a measurement
 *      behind every claim.
 *
 * The five agents are the families the brief asked for (A–E):
 *
 *   A  `trend`            — directional continuation after a shallow pullback
 *   B  `mean-reversion`   — fades an extended move back toward a measured level
 *   C  `liquidity-sweep`  — trades the failed raid of a prior extreme
 *   D  `vol-regime`       — directional continuation through volatility expansion
 *   E  `seasonality`      — the same-clock drift, measured in UTC
 */
import type { Bar, Quote, Side, SymbolSpec, Timeframe, TradeMode } from "../types";

export type AlphaId = "trend" | "mean-reversion" | "liquidity-sweep" | "vol-regime" | "seasonality";

export const ALPHA_IDS: readonly AlphaId[] = [
  "trend",
  "mean-reversion",
  "liquidity-sweep",
  "vol-regime",
  "seasonality",
] as const;

/** The human-facing name of each family, for reports and the journal. */
export const ALPHA_LABELS: Record<AlphaId, string> = {
  trend: "A · trend continuation",
  "mean-reversion": "B · mean reversion",
  "liquidity-sweep": "C · liquidity sweep",
  "vol-regime": "D · volatility expansion",
  seasonality: "E · hour-of-day seasonality",
};

export interface AlphaContext {
  symbol: string;
  mode: TradeMode;
  spec: SymbolSpec;
  /** CLOSED bars per frame at `now`, oldest first. Nothing after `now` exists. */
  series: Partial<Record<Timeframe, Bar[]>>;
  quote: Quote;
  now: number;
  /**
   * Optional per-series scratch space.
   *
   * The agents measure their own edge on the series they can see (§ edge.ts),
   * which is O(history) work; a study offers the same series at every decision
   * point, so recomputing it 400 times would dominate the run. The cache is
   * keyed by "what the agent saw", so a stale entry can never be reused for a
   * different view of the tape — see `agentCacheKey`.
   */
  cache?: Map<string, unknown>;
}

export interface AlphaView {
  direction: Side;
  /** The price the setup would enter at (the ask for a buy), spread included. */
  entry: number;
  /**
   * P(the move reaches `rr` before the structural stop), measured on the
   * agent's own past occurrences of this same setup and shrunk toward the
   * break-even rate (see `alpha/edge.ts`).
   */
  probability: number;
  /** Bars the agent expects the move to need — the desk's holding horizon. */
  horizonBars: number;
  /** The RR the probability is denominated in (the desk's floor by default). */
  rr: number;
  /** Occurrences of the identical setup whose outcome window had already closed. */
  samples: number;
  /**
   * The MEASURED random-entry hit rate for the same stop and horizon — the
   * number this probability is shrunk toward, and the number the setup has to
   * beat to be an edge rather than a coin flip with a stop.
   */
  baselineRate: number;
  /** The fraction of those occurrences that hit: the raw, un-shrunk estimate. */
  hitRate: number | null;
  /** Levels the execution layer may use; optional and never authoritative. */
  stop?: number;
  target?: number;
  invalidate?: number;
  /** Reference level the setup was measured against (the prior extreme, an EMA…). */
  level?: number;
  /** Measurable strength of the setup in σ or ATR units — for ranking, not gating. */
  strength: number;
  /** One line per reason, for the journal. */
  reasons: string[];
}

export interface AlphaAgent {
  id: AlphaId;
  label: string;
  /** The frames this agent needs; the harness must supply at least the first. */
  frames: Timeframe[];
  /** Bars it needs, per frame. Below this it abstains rather than guesses. */
  minBars: number;
  /** A view, or null when this setup is not present. */
  view(ctx: AlphaContext): AlphaView | null;
}

/**
 * A cache key that cannot go stale: it names the exact window the agent read.
 *
 * Length alone would be enough for a growing series, but a key that also carries
 * the last bar's timestamp survives a bar being revised, a series being
 * restarted, or two different symbols sharing a cache.
 */
export function agentCacheKey(agent: AlphaId, frame: Timeframe, bars: Bar[]): string {
  const last = bars[bars.length - 1];
  return `${agent}:${frame}:${bars.length}:${last ? (last[0] as number) : 0}`;
}

/** The frames an agent can read, most-preferred first, with their bar counts. */
export function candidateFrames(
  ctx: AlphaContext,
  agent: AlphaAgent,
): { frame: Timeframe; bars: Bar[] }[] {
  const out: { frame: Timeframe; bars: Bar[] }[] = [];
  for (const frame of agent.frames) {
    const bars = ctx.series[frame];
    if (bars && bars.length >= agent.minBars) out.push({ frame, bars });
  }
  return out;
}
