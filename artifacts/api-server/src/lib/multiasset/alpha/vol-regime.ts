/**
 * WP4 — agent D: VOLATILITY EXPANSION.
 *
 * ── THE CLAIM ───────────────────────────────────────────────────────────────
 *
 *   When volatility expands out of a quiet base in one direction, the move
 *   carries further than a random walk of that size would.
 *
 * This is the one family of the five whose edge is a property of *when* rather
 * than *where*: a breakout from a compressed range is the market repricing, and
 * a desk that enters only on days like that pays the spread far less often than
 * one that trades every bar.
 *
 * ── THE DETECTION ───────────────────────────────────────────────────────────
 *
 *   fast vol   EWMA of squared log returns, λ = 0.94  (~20 bars)
 *   slow vol   EWMA, λ = 0.99                         (~200 bars)
 *   expansion  fast ≥ 1.25 × slow — and ≤ 3 × slow. Beyond three times the base
 *              rate the move is a shock, and joining a shock at market is how a
 *              desk gets filled at the worst price of the day; the agent
 *              abstains rather than chase.
 *   direction  the sign of the 5-bar drift, and it must be at least half a σ of
 *              the slow regime (a coin-flip direction is not a setup)
 *
 * ── WHY NOT A FULL GARCH FIT ────────────────────────────────────────────────
 *
 * A GARCH(1,1) maximum-likelihood fit would be more elegant and would add three
 * parameters to estimate from every window. The WP4 fixture IS GARCH(1,1), so a
 * fit would measurably beat this ratio test on the fixture — and that is exactly
 * why the fixture is not the standard: parameters fitted to synthetic data are
 * worth nothing on a broker feed, and every parameter is another thing that can
 * be wrong without anything complaining. The two-EWMA ratio is the version whose
 * edge is measured on real data before anything is switched on, and the GARCH
 * alternative is recorded in `docs/mt5-live-desk-v4.md` as a WP5 candidate where
 * a fitted model has to justify itself out of sample anyway.
 */
import { CLOSE } from "../math";
import type { Bar } from "../types";
import { candidateFrames, type AlphaAgent, type AlphaContext, type AlphaView } from "./types";
import {
  DEFAULT_ALPHA_CONFIG,
  atrSeries,
  entryPriceOf,
  returnScale,
  returnSeries,
  selfMeasured,
  type AlphaConfig,
  type MeasuredSignal,
} from "./edge";

const LAMBDA_FAST = 0.94;
const LAMBDA_SLOW = 0.99;
/** Bars before the slow EWMA has genuinely forgotten its seed. */
const WARMUP = 150;

export interface VolRegimeAgentOptions {
  cfg?: AlphaConfig;
  /** fast/slow vol ratio that counts as expansion. */
  minExpansion?: number;
  /** …and the ratio above which the agent refuses to join (a shock). */
  maxExpansion?: number;
  /** Minimum |drift| in slow-σ units before a direction is claimable. */
  minDriftSigma?: number;
  driftBars?: number;
}

export function volRegimeAgent(options: VolRegimeAgentOptions = {}): AlphaAgent {
  const cfg = options.cfg ?? DEFAULT_ALPHA_CONFIG;
  const minExpansion = options.minExpansion ?? 1.25;
  const maxExpansion = options.maxExpansion ?? 3;
  const minDriftSigma = options.minDriftSigma ?? 0.5;
  const driftBars = options.driftBars ?? 5;

  const agent: AlphaAgent = {
    id: "vol-regime",
    label: "D · volatility expansion",
    frames: ["M15", "M5", "M30", "H1"],
    minBars: WARMUP + 60,
    view(ctx: AlphaContext): AlphaView | null {
      const choice = candidateFrames(ctx, agent)[0];
      if (!choice) return null;
      const { frame, bars } = choice;
      const spread = ctx.spec.spreadPoints * ctx.spec.point;
      const stopAtr = cfg.stopAtr[ctx.mode];

      const closes = bars.map((b) => b[CLOSE] as number);
      const returns = returnSeries(bars);
      const atrValues = atrSeries(bars, 14);

      // Two EWMAs of the squared returns, computed in one forward pass each.
      const fast: number[] = new Array(bars.length).fill(0) as number[];
      const slow: number[] = new Array(bars.length).fill(0) as number[];
      let vFast = returns[0] !== undefined ? returns[0] ** 2 : 0;
      let vSlow = vFast;
      for (let i = 0; i < bars.length; i++) {
        const r = returns[i] as number;
        if (i > 0) {
          vFast = LAMBDA_FAST * vFast + (1 - LAMBDA_FAST) * r * r;
          vSlow = LAMBDA_SLOW * vSlow + (1 - LAMBDA_SLOW) * r * r;
        }
        fast[i] = vFast;
        slow[i] = vSlow;
      }

      const signalAt = (index: number): MeasuredSignal | null => {
        if (index < WARMUP) return null;
        const atrValue = atrValues[index] as number;
        if (!(atrValue > 0)) return null;
        const volFast = Math.sqrt(Math.max(0, fast[index] as number));
        const volSlow = Math.sqrt(Math.max(0, slow[index] as number));
        if (!(volSlow > 0) || !(volFast > 0)) return null;
        const ratio = volFast / volSlow;
        if (ratio < minExpansion || ratio > maxExpansion) return null;

        const drift =
          (closes[index] as number) - (closes[Math.max(0, index - driftBars)] as number);
        const driftSigma = drift / (volSlow * Math.sqrt(driftBars));
        if (Math.abs(driftSigma) < minDriftSigma) return null;

        const direction: "buy" | "sell" = driftSigma > 0 ? "buy" : "sell";
        return {
          direction,
          entry: entryPriceOf(closes[index] as number, direction, spread),
          stopDistance: stopAtr * atrValue,
          strength: ratio,
          level: closes[Math.max(0, index - driftBars)] as number,
        };
      };

      const measured = selfMeasured({
        ctx,
        agent: "vol-regime",
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
      const scale = returnScale(bars);
      const volFast = Math.sqrt(Math.max(0, fast[bars.length - 1] as number));

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
          `volatility expanded to ${signal.strength.toFixed(2)}× its own base rate (${(volFast / (scale || 1)).toFixed(2)}× the 100-bar σ)`,
          `the ${driftBars}-bar drift is on the ${signal.direction === "buy" ? "up" : "down"} side and larger than half a σ of the base regime`,
          `expansion is inside the ${minExpansion}–${maxExpansion}× band: a repricing, not a shock to chase`,
          `measured on ${edge.occurrences} closed occurrences of this setup: ${edge.hits} reached ${cfg.rr}R before the stop`,
          `stated probability ${((edge.probability as number) * 100).toFixed(1)}% against a measured random-entry baseline of ${(edge.baselineRate * 100).toFixed(1)}% (${edge.baselineOutcomes} baseline windows)`,
        ],
      };
    },
  };
  return agent;
}
