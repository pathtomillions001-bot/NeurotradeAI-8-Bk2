/**
 * The causal ATR series.
 *
 * `math.atrSeries` is the identical recursion in one forward pass; this wrapper
 * zeroes the warmup instead of emitting a value computed from too few bars. The
 * zero is the point: a feature built on a three-bar "ATR" is not an ATR, and a
 * zero makes that visible to every caller (`!(atr > 0)` refuses) rather than
 * hiding it behind a plausible-looking number.
 *
 * It lives in `meta/` because the meta-model's feature vector and the WP6
 * executed-policy MC both read it, and a live module may not import from the
 * research harness. Equivalence with `atrSeries` at every post-warmup index is
 * asserted in `research/executed-policy.test.ts`.
 */
import { atrSeries } from "../math";
import type { Bar } from "../types";

export function causalAtrSeries(bars: Bar[], period = 14): number[] {
  const series = atrSeries(bars, period);
  return series.map((value, i) => (i < period + 1 ? 0 : value));
}
