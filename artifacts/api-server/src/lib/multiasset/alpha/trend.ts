/**
 * WP4 — agent A: TREND CONTINUATION.
 *
 * ── THE CLAIM ───────────────────────────────────────────────────────────────
 *
 *   After a directional move, a SHALLOW counter-move that holds a rising (or
 *   falling) structure is more likely to resume than to reverse.
 *
 * The classical "trend plus a pullback" claim, and the one the brief's
 * entry-style requirement rests on: institutional entries are pullbacks and
 * retests, never the breakout itself — by the time a breakout is visible it has
 * already paid the spread, and the stop it needs is the one everybody else is
 * also using.
 *
 * ── THE DETECTION (all causal, all structural) ──────────────────────────────
 *
 *   structure  EMA(9) vs EMA(21) — which side the fast line is on
 *   slope      the slow EMA must still be moving; a flat line is a range
 *   pullback   the last close is BACK INSIDE the fast→slow band: the market
 *              retraced into value instead of extending away from it
 *   location   the close is still on the trend's side of the slow EMA
 *   width      the band must be at least a tenth of an ATR wide — two crossing
 *              lines are not a trend, however confident they look
 *
 * 9 and 21 are the short/medium EMAs the desk already computes, and the
 * pullback condition is geometric. The probability is measured, never asserted
 * (`edge.ts`): it is the hit rate of THIS setup on the bars the agent can see,
 * against the desk's own structural stop and its own 1:2 floor.
 *
 * ── THE HONEST LIMIT ────────────────────────────────────────────────────────
 *
 * A trend agent on structureless data has nothing to find, and the WP4 null test
 * asserts it finds nothing. It is also the agent most likely to be fooled by a
 * slow, drifting tape that is not a trend — which is why the regime agent (WP3)
 * exists and why the null gates are measured on phase-randomised data, where
 * linear structure survives and drift does not.
 */
import { CLOSE } from "../math";
import type { Bar } from "../types";
import { candidateFrames, type AlphaAgent, type AlphaContext, type AlphaView } from "./types";
import {
  DEFAULT_ALPHA_CONFIG,
  atrSeries,
  emaArray,
  entryPriceOf,
  selfMeasured,
  type AlphaConfig,
  type MeasuredSignal,
} from "./edge";

const FAST = 9;
const SLOW = 21;
/** Bars of EMA history before the structure means anything. */
const WARMUP = SLOW + 5;

export interface TrendAgentOptions {
  cfg?: AlphaConfig;
  /**
   * How wide the fast→slow band must be, in ATR, before it counts as structure.
   *
   * Structural rather than tuned: two EMAs a twentieth of an ATR apart are
   * crossing, not trending, and a "trend" thinner than the spread is a
   * commission donation. Measured against the labelled control by the study.
   */
  minBandAtr?: number;
  /** The close must be at least this far off the fast EMA — a real pullback. */
  minPullbackAtr?: number;
}

export function trendAgent(options: TrendAgentOptions = {}): AlphaAgent {
  const cfg = options.cfg ?? DEFAULT_ALPHA_CONFIG;
  const minBandAtr = options.minBandAtr ?? 0.1;
  const minPullbackAtr = options.minPullbackAtr ?? 0.05;

  const agent: AlphaAgent = {
    id: "trend",
    label: "A · trend continuation",
    frames: ["M15", "H1", "M30", "M5"],
    minBars: 120,
    view(ctx: AlphaContext): AlphaView | null {
      const choice = candidateFrames(ctx, agent)[0];
      if (!choice) return null;
      const { frame, bars } = choice;
      const spread = ctx.spec.spreadPoints * ctx.spec.point;
      const stopAtr = cfg.stopAtr[ctx.mode];

      const closes = bars.map((b) => b[CLOSE] as number);
      const fast = emaArray(closes, FAST);
      const slow = emaArray(closes, SLOW);
      const atrValues = atrSeries(bars, 14);

      const signalAt = (index: number): MeasuredSignal | null => {
        if (index < WARMUP) return null;
        const fastNow = fast[index] as number;
        const slowNow = slow[index] as number;
        const atrValue = atrValues[index] as number;
        if (!(atrValue > 0)) return null;
        const band = fastNow - slowNow;
        if (Math.abs(band) < atrValue * minBandAtr) return null;
        const slope = slowNow - (slow[Math.max(0, index - 5)] as number);
        const up = band > 0 && slope > 0;
        const down = band < 0 && slope < 0;
        if (!up && !down) return null;
        const direction: "buy" | "sell" = up ? "buy" : "sell";
        const close = closes[index] as number;
        // Inside the band: retraced past the fast line, still holding the slow one.
        const insideBand = up ? close < fastNow && close > slowNow : close > fastNow && close < slowNow;
        if (!insideBand) return null;
        if (Math.abs(fastNow - close) < atrValue * minPullbackAtr) return null;
        return {
          direction,
          entry: entryPriceOf(close, direction, spread),
          stopDistance: stopAtr * atrValue,
          strength: Math.abs(band) / atrValue,
          level: slowNow,
        };
      };

      const measured = selfMeasured({
        ctx,
        agent: "trend",
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
        strength: signal.strength,
        reasons: [
          `EMA(${FAST}) ${signal.direction === "buy" ? "above" : "below"} EMA(${SLOW}) with the slow line still moving`,
          `the close retraced into the ${FAST}/${SLOW} band and held the structure on the ${frame} frame`,
          `band width ${signal.strength.toFixed(2)} ATR, risk ${(risk / (atrValues[bars.length - 1] as number)).toFixed(2)} ATR`,
          `measured on ${edge.occurrences} closed occurrences of this setup: ${edge.hits} reached ${cfg.rr}R before the stop`,
          `stated probability ${((edge.probability as number) * 100).toFixed(1)}% (break-even at ${cfg.rr}R: ${((100 / (1 + cfg.rr))).toFixed(1)}%)`,
        ],
      };
    },
  };
  return agent;
}
