/**
 * WP4 — agent C: LIQUIDITY SWEEP (the failed raid).
 *
 * ── THE CLAIM ───────────────────────────────────────────────────────────────
 *
 *   When price spikes THROUGH a level where resting orders sit, then closes back
 *   inside the old range, the move was absorbed: somebody sold the raid (or
 *   bought the flush) into strength, and the market is more likely to travel the
 *   other way than to continue.
 *
 * This is the "institutional entry" the brief asks for, in its purest form. It
 * is also the easiest of the five to fake: a bar that pokes one tick above a
 * 20-bar high is a "sweep" to a naive detector and noise to a market. Three
 * structural conditions separate the two:
 *
 *   penetration  the raid went somewhere: at least 0.1 × ATR beyond the level
 *   absorption   the bar closed back inside the prior range, gave back at least
 *                half of the excursion, and the rejection side of the bar
 *                dominates its body — a rejection, not a slow grind
 *
 * The stop is the desk's structural stop (in ATR), so a sweep that keeps going
 * is a loss of exactly 1R — which is why the sweep's hit rate has to be measured
 * rather than believed.
 */
import { CLOSE, HIGH, LOW, OPEN } from "../math";
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

/** Bars of prior range the raid has to break. */
const LOOKBACK = 20;
const WARMUP = LOOKBACK + 15;

export interface LiquiditySweepAgentOptions {
  cfg?: AlphaConfig;
  lookback?: number;
  /** How far beyond the level the raid must reach, in ATR. */
  minPenetrationAtr?: number;
  /**
   * How much of the raid has to be given back before it counts as ABSORBED.
   *
   * Structural, and measured before it was chosen: across four fixtures the
   * median raid-and-close-inside bar gives back about 60% of its excursion, and
   * requiring the full penny — "the wick must be half the bar's range", the
   * first version of this filter — cut ~280 plausible raids to 3. A raid that
   * gives back half of its excursion, on a bar whose rejection side dominates
   * its body, is a raid that failed.
   */
  minGiveBack?: number;
}

export function liquiditySweepAgent(options: LiquiditySweepAgentOptions = {}): AlphaAgent {
  const cfg = options.cfg ?? DEFAULT_ALPHA_CONFIG;
  const lookback = options.lookback ?? LOOKBACK;
  const minPenetrationAtr = options.minPenetrationAtr ?? 0.1;
  const minGiveBack = options.minGiveBack ?? 0.5;

  const agent: AlphaAgent = {
    id: "liquidity-sweep",
    label: "C · liquidity sweep",
    frames: ["M15", "M5", "M30", "H1"],
    minBars: WARMUP + 20,
    view(ctx: AlphaContext): AlphaView | null {
      const choice = candidateFrames(ctx, agent)[0];
      if (!choice) return null;
      const { frame, bars } = choice;
      const spread = ctx.spec.spreadPoints * ctx.spec.point;
      const stopAtr = cfg.stopAtr[ctx.mode];

      const atrValues = atrSeries(bars, 14);
      const high = bars.map((b) => b[HIGH] as number);
      const low = bars.map((b) => b[LOW] as number);
      const close = bars.map((b) => b[CLOSE] as number);
      const open = bars.map((b) => b[OPEN] as number);

      const signalAt = (index: number): MeasuredSignal | null => {
        if (index < Math.max(WARMUP, lookback + 2)) return null;
        const atrValue = atrValues[index] as number;
        if (!(atrValue > 0)) return null;
        const bar = bars[index] as Bar;
        const barHigh = high[index] as number;
        const barLow = low[index] as number;
        const barClose = close[index] as number;
        const barOpen = open[index] as number;
        const range = barHigh - barLow;
        if (!(range > 0)) return null;

        let priorHigh = -Infinity;
        let priorLow = Infinity;
        for (let j = index - lookback; j < index; j++) {
          const h = high[j] as number;
          const l = low[j] as number;
          if (h > priorHigh) priorHigh = h;
          if (l < priorLow) priorLow = l;
        }
        if (!Number.isFinite(priorHigh) || !Number.isFinite(priorLow)) return null;
        const penetration = atrValue * minPenetrationAtr;

        const body = Math.abs(barClose - barOpen);

        // Raid UP through the prior high, closed back below it → fade the raid.
        const raidUp = barHigh > priorHigh + penetration && barClose < priorHigh;
        if (raidUp) {
          const excursion = barHigh - priorHigh;
          const gaveBack = priorHigh - barClose;
          const upperWick = barHigh - Math.max(barClose, barOpen);
          // The rejection side must dominate the body (the bar traded away and
          // came back) and the raid must have been mostly given back.
          if (gaveBack >= excursion * minGiveBack && upperWick >= Math.max(body, range * 0.2)) {
            const direction = "sell" as const;
            return {
              direction,
              entry: entryPriceOf(barClose, direction, spread),
              stopDistance: stopAtr * atrValue,
              strength: excursion / atrValue,
              level: priorHigh,
            };
          }
        }

        // Raid DOWN through the prior low, closed back above it → buy the flush.
        const raidDown = barLow < priorLow - penetration && barClose > priorLow;
        if (raidDown) {
          const excursion = priorLow - barLow;
          const gaveBack = barClose - priorLow;
          const lowerWick = Math.min(barClose, barOpen) - barLow;
          if (gaveBack >= excursion * minGiveBack && lowerWick >= Math.max(body, range * 0.2)) {
            const direction = "buy" as const;
            return {
              direction,
              entry: entryPriceOf(barClose, direction, spread),
              stopDistance: stopAtr * atrValue,
              strength: excursion / atrValue,
              level: priorLow,
            };
          }
        }
        return null;
      };

      const measured = selfMeasured({
        ctx,
        agent: "liquidity-sweep",
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
        invalidate: signal.level,
        strength: signal.strength,
        reasons: [
          `the ${LOOKBACK}-bar ${signal.direction === "buy" ? "low" : "high"} at ${(signal.level as number).toFixed(5)} was raided by ${signal.strength.toFixed(2)} ATR and closed back inside`,
          `the bar gave back at least half the raid with the rejection side dominating its body — absorbed, not continued`,
          `measured on ${edge.occurrences} closed occurrences of this setup: ${edge.hits} reached ${cfg.rr}R before the stop`,
          `stated probability ${((edge.probability as number) * 100).toFixed(1)}% against a measured random-entry baseline of ${(edge.baselineRate * 100).toFixed(1)}% (${edge.baselineOutcomes} baseline windows)`,
        ],
      };
    },
  };
  return agent;
}
