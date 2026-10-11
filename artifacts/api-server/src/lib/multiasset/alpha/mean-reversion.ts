/**
 * WP4 — agent B: MEAN REVERSION.
 *
 * ── THE CLAIM ───────────────────────────────────────────────────────────────
 *
 *   A move that is far from its own recent average, in units of its own recent
 *   volatility, is more likely to return to that average than to keep going.
 *
 * ── THE DETECTION (all causal, all structural) ──────────────────────────────
 *
 *   climax      the PREVIOUS bar closed at the extreme of its own 20-bar window
 *               (the lowest close for a buy, the highest for a sell) — the push
 *               itself
 *   extension   that extreme is at least half an ATR (and three spreads) away
 *               from the window's average, so there is something to revert toward
 *   stall       the decision bar then CLOSES BACK toward the middle: green after
 *               a flush, red after a spike. Buying a falling knife because it is
 *               "cheap" is the classic way to lose money with a mean-reversion
 *               system, and this is the condition that refuses it.
 *
 * ── WHY THE STALL IS THE SECOND BAR, NOT THE FIRST ──────────────────────────
 *
 * The first version of this agent asked for the same bar to be BOTH at the
 * window's extreme AND closing back the other way (a green bar at the bottom
 * tenth), and the measured result was a detector that could only ever go long:
 * bars open exactly at the previous close, so a bar whose close is the maximum of
 * its window is never below its own open — 3,905 top-tenth closes in 12 series
 * produced ZERO red bars, i.e. not one sell signal was structurally reachable,
 * while the buy side fired 965 times. The two-bar form has no such contradiction:
 * the climax bar establishes the extreme, the decision bar says the push stopped,
 * and the entry is the decision bar's close — which is the bar the desk prices
 * from anyway.
 *   materiality the displacement must be worth more than the spread, or the
 *               reversion is paid to the broker
 *
 * ── WHY THE STALL CONDITION MATTERS ─────────────────────────────────────────
 *
 * z ≤ −2 is a statement about the PAST. The stall bar is the first piece of
 * evidence about the present — the market accepted a lower price and then did
 * not hold it. The WP4 study measures both variants on the same fixture, and the
 * stall variant is the one with a measured edge (see the report).
 */
import { CLOSE, OPEN, mean as meanOf } from "../math";
import type { Bar } from "../types";
import { candidateFrames, type AlphaAgent, type AlphaContext, type AlphaView } from "./types";
import {
  DEFAULT_ALPHA_CONFIG,
  atrSeries,
  entryPriceOf,
  selfMeasured,
  type AlphaConfig,
  type MeasuredSignal,
} from "./edge";

const WINDOW = 20;
/** Bars of history before a percentile of a 20-bar window means anything. */
const WARMUP = WINDOW * 2;

export interface MeanReversionAgentOptions {
  cfg?: AlphaConfig;
  /**
   * Require the decision bar to close back toward the middle before fading.
   *
   * Structural: the climax alone says "far", and "far" is how a falling knife is
   * described. Turning this off is the measured alternative variant, and the
   * study reports both rather than arguing about it.
   */
  requireStall?: boolean;
  /** How far from the window's average the close must be, in ATR. */
  minDisplacementAtr?: number;
}

export function meanReversionAgent(options: MeanReversionAgentOptions = {}): AlphaAgent {
  const cfg = options.cfg ?? DEFAULT_ALPHA_CONFIG;
  const minDisplacementAtr = options.minDisplacementAtr ?? 0.5;
  const requireStall = options.requireStall ?? true;

  const agent: AlphaAgent = {
    id: "mean-reversion",
    label: "B · mean reversion",
    frames: ["M15", "M5", "M30", "H1"],
    minBars: WARMUP + 20,
    view(ctx: AlphaContext): AlphaView | null {
      const choice = candidateFrames(ctx, agent)[0];
      if (!choice) return null;
      const { frame, bars } = choice;
      const spread = ctx.spec.spreadPoints * ctx.spec.point;
      const stopAtr = cfg.stopAtr[ctx.mode];

      const closes = bars.map((b) => b[CLOSE] as number);
      const opens = bars.map((b) => b[OPEN] as number);
      const atrValues = atrSeries(bars, 14);

      const signalAt = (index: number): MeasuredSignal | null => {
        if (index < WARMUP) return null;
        const atrValue = atrValues[index] as number;
        if (!(atrValue > 0)) return null;
        const climaxIndex = index - 1;
        const windowCloses = closes.slice(climaxIndex + 1 - WINDOW, climaxIndex + 1);
        if (windowCloses.length < WINDOW) return null;
        const climax = closes[climaxIndex] as number;
        const average = meanOf(windowCloses);
        // The climax bar must be the window's own extreme: nothing in the window
        // closed beyond it, so this is the push, not a bar inside the range.
        //
        // Compared directly against every close in the window, NOT through a
        // percentile rank. The rank of a window's own maximum over n values is
        // (n−1)/n, never 1 — the first version of this test asked for
        // `rank >= 1 - 1e-9` on the sell side and was therefore unreachable, while
        // the buy side's `rank <= 0` worked, which is how a "mean reversion" agent
        // came to be structurally long-only. Measured: 3,905 top-tenth closes,
        // zero sell signals.
        const climaxedLow = windowCloses.every((value) => climax <= value);
        const climaxedHigh = windowCloses.every((value) => climax >= value);
        if (!climaxedLow && !climaxedHigh) return null;
        // A window of 20 identical closes would satisfy both; a flat market is not
        // a setup, so it is refused rather than resolved arbitrarily.
        if (climaxedLow && climaxedHigh) return null;
        const direction: "buy" | "sell" = climaxedLow ? "buy" : "sell";
        const close = closes[index] as number;
        // The stall: the decision bar closes back toward the middle.
        if (requireStall) {
          const green = close > (opens[index] as number);
          if (direction === "buy" ? !green : green) return null;
        }
        // Extension has to be material: an extreme a tenth of an ATR from its own
        // average is inside the noise, and the reversion would be spent on the
        // spread long before it reached the stop.
        const dislocation = Math.abs(climax - average);
        if (dislocation < Math.max(atrValue * minDisplacementAtr, spread * 3)) return null;
        return {
          direction,
          entry: entryPriceOf(close, direction, spread),
          stopDistance: stopAtr * atrValue,
          strength: dislocation / Math.max(atrValue, Number.EPSILON),
          level: average,
        };
      };

      const measured = selfMeasured({
        ctx,
        agent: "mean-reversion",
        frame,
        bars,
        signalAt,
        startIndex: WARMUP,
        cfg,
        // The random-entry comparator uses the same stop geometry at every bar:
        // "what if I entered here at random with this mode's stop and horizon?"
        baselineStopAt: (i) => stopAtr * (atrValues[i] as number),
      });
      if (!measured) return null;
      const { signal, edge } = measured;
      const risk = signal.stopDistance;
      const displacement = signal.level !== undefined ? Math.abs(signal.entry - signal.level) : 0;

      return {
        direction: signal.direction,
        entry: signal.entry,
        probability: edge.probability as number,
        horizonBars: cfg.horizonBars[ctx.mode],
        rr: cfg.rr,
        samples: edge.occurrences,
        hitRate: edge.hitRate,
        baselineRate: edge.baselineRate,
        stop: signal.direction === "buy" ? signal.entry - risk : signal.entry + risk,
        target: signal.direction === "buy" ? signal.entry + cfg.rr * risk : signal.entry - cfg.rr * risk,
        level: signal.level,
        strength: signal.strength,
        reasons: [
          `the previous bar closed at the ${signal.direction === "buy" ? "bottom" : "top"} of its own ${WINDOW}-bar range, ${(displacement / (atrValues[bars.length - 1] as number)).toFixed(2)} ATR from the average`,
          requireStall ? "the decision bar closed back toward the average — the push stalled" : "no stall filter (measured variant)",
          `measured on ${edge.occurrences} closed occurrences of this setup: ${edge.hits} reached ${cfg.rr}R before the stop`,
          `stated probability ${((edge.probability as number) * 100).toFixed(1)}% against a measured random-entry baseline of ${(edge.baselineRate * 100).toFixed(1)}% (${edge.baselineOutcomes} baseline windows)`,
        ],
      };
    },
  };
  return agent;
}
