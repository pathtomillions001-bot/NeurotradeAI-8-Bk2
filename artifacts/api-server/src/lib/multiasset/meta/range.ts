/**
 * The trailing mean bar range — the denominator of the ATR-relative feature.
 *
 * Causal by construction: position `i` averages bars `i−period+1 .. i`, and the
 * first `period−1` positions are null rather than a partial average over a
 * shorter window (a partial window is a different statistic, and at the start of
 * a series it is a much smaller one).
 *
 * It lives in `meta/` because the meta-model's feature vector reads it live and
 * in the study; the study's `trailingRangeMean` is this function.
 */
import { HIGH, LOW } from "../math";
import type { Bar } from "../types";

export function trailingRangeMean(bars: Bar[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (!(period >= 1)) return out;
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i] as Bar;
    sum += (bar[HIGH] as number) - (bar[LOW] as number);
    if (i >= period) {
      const old = bars[i - period] as Bar;
      sum -= (old[HIGH] as number) - (old[LOW] as number);
    }
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
