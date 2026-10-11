/**
 * WP4 — agent E: HOUR-OF-DAY SEASONALITY.
 *
 * ── THE CLAIM ───────────────────────────────────────────────────────────────
 *
 *   Some clock hours carry a persistent direction: the London open bids, the New
 *   York afternoon fades. If that is true, it is knowable in advance — the clock
 *   is the one variable no market can hide — and it is measurable from history.
 *
 * ── THE DETECTION ───────────────────────────────────────────────────────────
 *
 * For the UTC hour of the decision bar, the agent measures the mean and the
 * standard deviation of that hour's returns over every occurrence it can see,
 * and states a view only when
 *
 *   t = mean / (σ / √n) ≥ 2.5
 *
 * Two things follow from that. The bar has to have been seen at least
 * `minSamples` (12) times — a "pattern" from four observations is a story, not a
 * measurement — and the evidence must be strong in its OWN units, so a quiet
 * hour with a tiny drift does not qualify just because its noise is even
 * quieter.
 *
 * ── WHY THIS AGENT ABSTAINS OFTEN, AND WHY THAT IS THE POINT ────────────────
 *
 * The live bar store keeps a few hundred bars; on M15 that is a handful of days,
 * which is not enough occurrences of any single hour, so the agent will mostly
 * say nothing. It abstains rather than guess, and `samples` in the view says
 * how much evidence the claim rests on. In a study with months of history it
 * fires — and the WP4 study measures whether those fires are worth anything.
 *
 * ── THE KNOWN WEAKNESS, STATED ──────────────────────────────────────────────
 *
 * The 24 hours are tested independently, so at a 2.5σ bar about one hour in 25
 * looks "significant" on pure noise, and once an hour qualifies the agent fires
 * on every bar of that hour. WP5's multiple-testing control (Benjamini–Hochberg
 * at q = 0.10) is what fixes the family-wise error; until then the null test in
 * the WP4 study is what keeps this honest, and it is run on the strictest null
 * (phase-randomised), not just on the easy one.
 */
import { CLOSE } from "../math";
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

/** Occurrences of the same clock hour before a view may be stated. */
const MIN_SAMPLES = 12;
/** |t| of the hour's mean return before the view is claimable. */
const MIN_T = 2.5;

export interface SeasonalityAgentOptions {
  cfg?: AlphaConfig;
  minSamples?: number;
  minT?: number;
  /** Bars of warm-up: a few days of the frame are needed before hours repeat. */
  warmupBars?: number;
}

export function seasonalityAgent(options: SeasonalityAgentOptions = {}): AlphaAgent {
  const cfg = options.cfg ?? DEFAULT_ALPHA_CONFIG;
  const minSamples = options.minSamples ?? MIN_SAMPLES;
  const minT = options.minT ?? MIN_T;
  const warmupBars = options.warmupBars ?? 240;

  const agent: AlphaAgent = {
    id: "seasonality",
    label: "E · hour-of-day seasonality",
    frames: ["M15", "M5", "H1"],
    minBars: 300,
    view(ctx: AlphaContext): AlphaView | null {
      const choice = candidateFrames(ctx, agent)[0];
      if (!choice) return null;
      const { frame, bars } = choice;
      const spread = ctx.spec.spreadPoints * ctx.spec.point;
      const stopAtr = cfg.stopAtr[ctx.mode];

      const closes = bars.map((b) => b[CLOSE] as number);
      const atrValues = atrSeries(bars, 14);

      /**
       * Running per-hour statistics, advanced monotonically.
       *
       * `signalAt` is called with increasing indices (the outcome table is built
       * forward, and the decision bar is the largest index), so a cursor that
       * only ever moves forward keeps this O(1) amortised — and, more
       * importantly, means the evidence for a view at bar *i* is exactly the
       * returns of bars *≤ i*: the same hour seen in the past, never the future.
       */
      const hours = Array.from({ length: 24 }, () => ({ n: 0, sum: 0, sumSq: 0 }));
      let cursor = -1;
      const advanceTo = (index: number): void => {
        for (let j = cursor + 1; j <= index; j++) {
          if (j < 1) continue;
          const prev = closes[j - 1] as number;
          const now = closes[j] as number;
          if (!(prev > 0) || !(now > 0)) continue;
          const r = Math.log(now / prev);
          const hour = new Date((bars[j] as Bar)[0] as number).getUTCHours();
          const bucket = hours[hour] as { n: number; sum: number; sumSq: number };
          bucket.n++;
          bucket.sum += r;
          bucket.sumSq += r * r;
        }
        cursor = Math.max(cursor, index);
      };

      const signalAt = (index: number): MeasuredSignal | null => {
        if (index < warmupBars) return null;
        const atrValue = atrValues[index] as number;
        if (!(atrValue > 0)) return null;
        advanceTo(index);
        const hour = new Date((bars[index] as Bar)[0] as number).getUTCHours();
        const bucket = hours[hour] as { n: number; sum: number; sumSq: number };
        // The evidence must be about the PAST occurrences of this hour: the
        // current bar is part of it, which is legitimate (its return is known at
        // its own close) but it can never be the majority of it.
        if (bucket.n < minSamples) return null;
        const mean = bucket.sum / bucket.n;
        const variance = Math.max(0, bucket.sumSq / bucket.n - mean * mean);
        const sigma = Math.sqrt(variance);
        if (!(sigma > 0)) return null;
        const t = mean / (sigma / Math.sqrt(bucket.n));
        if (Math.abs(t) < minT) return null;
        const direction: "buy" | "sell" = t > 0 ? "buy" : "sell";
        return {
          direction,
          entry: entryPriceOf(closes[index] as number, direction, spread),
          stopDistance: stopAtr * atrValue,
          strength: Math.abs(t) / minT,
          level: undefined,
        };
      };

      const measured = selfMeasured({
        ctx,
        agent: "seasonality",
        frame,
        bars,
        signalAt,
        startIndex: warmupBars,
        cfg,
        // The random-entry comparator uses the same stop geometry at every bar:
        // "what if I entered here at random with this mode's stop and horizon?"
        baselineStopAt: (i) => stopAtr * (atrValues[i] as number),
      });
      if (!measured) return null;
      const { signal, edge } = measured;
      const risk = signal.stopDistance;
      const hour = new Date((bars[bars.length - 1] as Bar)[0] as number).getUTCHours();
      const bucket = hours[hour] as { n: number; sum: number; sumSq: number };
      const hourMean = bucket.n > 0 ? bucket.sum / bucket.n : 0;

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
        strength: signal.strength,
        reasons: [
          `UTC ${String(hour).padStart(2, "0")}:00 carries a ${hourMean >= 0 ? "positive" : "negative"} mean return over ${bucket.n} occurrences (t = ${(signal.strength * minT).toFixed(1)})`,
          `the clock pattern is measured from history, never assumed`,
          `measured on ${edge.occurrences} closed occurrences of this setup: ${edge.hits} reached ${cfg.rr}R before the stop`,
          `stated probability ${((edge.probability as number) * 100).toFixed(1)}% against a measured random-entry baseline of ${(edge.baselineRate * 100).toFixed(1)}% (${edge.baselineOutcomes} baseline windows)`,
        ],
      };
    },
  };
  return agent;
}
