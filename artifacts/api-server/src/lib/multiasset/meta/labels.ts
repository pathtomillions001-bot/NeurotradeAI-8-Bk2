/**
 * WP5 — triple-barrier labels.
 *
 * ── WHY NOT "DID THE TRADE WIN" ─────────────────────────────────────────────
 *
 * The obvious label — take the trade, see whether it made money — is a label
 * with no shelf life. It depends on where the stop happened to be placed, on
 * when the position happened to be closed, and on the desk's own management
 * rules, so a model trained on it learns the desk rather than the market. It is
 * also unbalanced in a way that flatters itself: with a 1:2 target, a "win" is
 * rare by construction, and a model trained on rare wins happily predicts 0.
 *
 * The triple barrier labels the OUTCOME OF THE IDEA, on three barriers:
 *
 *   +1  the profit barrier (rr × risk) was reached first
 *   −1  the stop barrier was reached first
 *    0  neither was reached before the time barrier (the horizon expired)
 *
 * A 0 is information, not a missing value: "this setup went nowhere fast enough"
 * is exactly what the desk pays the spread for. The label carries `t1` (the index
 * at which the barrier was touched or the horizon expired) because that index is
 * what makes sample weighting possible at all — two setups whose owning periods
 * overlap are not two independent observations (see `uniqueness.ts`), and the
 * purged folds in the WP5 study use the same index to decide what a fold may see.
 *
 * Intrabar resolution is the pessimistic one the rest of the programme uses: if
 * one bar spans both barriers, the stop is assumed first.
 */
import { CLOSE, HIGH, LOW } from "../math";
import type { Bar, Side } from "../types";

export type TripleBarrierLabel = 1 | -1 | 0;

export interface LabelledEvent {
  /** Bar index of the event (the decision bar). */
  index: number;
  /** Bar index at which the label resolved: the barrier touch or the horizon. */
  t1: number;
  label: TripleBarrierLabel;
  side: Side;
  /** Realised R at `t1`, net of the round-trip cost when one is supplied. */
  rMultiple: number;
  /** True when the time barrier closed it rather than either price barrier. */
  timedOut: boolean;
}

export interface TripleBarrierInput {
  bars: Bar[];
  index: number;
  side: Side;
  entry: number;
  /** Price distance to the stop (the risk unit). */
  riskPrice: number;
  /** Reward:risk of the profit barrier. */
  rr: number;
  horizonBars: number;
  /** Round-trip cost in price units, subtracted from the realised multiple. */
  costPrice?: number;
}

/**
 * Label one event, or return null when its horizon has not finished yet.
 *
 * Returning null rather than a provisional label is deliberate: an unlabelled
 * event is one the model may not train on, and "not yet known" must never be
 * encoded as "did not work".
 */
export function tripleBarrier(input: TripleBarrierInput): LabelledEvent | null {
  const { bars, index, side, entry, riskPrice, rr, horizonBars } = input;
  if (!(riskPrice > 0) || !Number.isFinite(entry)) return null;
  const end = index + 1 + horizonBars;
  if (end > bars.length) return null; // the horizon has not finished: no label
  const cost = input.costPrice ?? 0;
  const stop = side === "buy" ? entry - riskPrice : entry + riskPrice;
  const target = side === "buy" ? entry + rr * riskPrice : entry - rr * riskPrice;

  for (let j = index + 1; j < end; j++) {
    const bar = bars[j] as Bar;
    const high = bar[HIGH] as number;
    const low = bar[LOW] as number;
    const stopHit = side === "buy" ? low <= stop : high >= stop;
    const targetHit = side === "buy" ? high >= target : low <= target;
    if (stopHit) {
      // Pessimistic: the stop wins a same-bar tie, and a stop that gapped
      // through fills at the open — which is at or beyond the barrier price.
      const fill = side === "buy" ? Math.min(stop, bar[CLOSE] as number) : Math.max(stop, bar[CLOSE] as number);
      const r = (side === "buy" ? fill - entry : entry - fill) / riskPrice;
      return { index, t1: j, label: -1, side, rMultiple: r - cost / riskPrice, timedOut: false };
    }
    if (targetHit) {
      return { index, t1: j, label: 1, side, rMultiple: rr - cost / riskPrice, timedOut: false };
    }
  }
  // The time barrier: marked at the close of the last bar in the horizon.
  const last = bars[end - 1] as Bar;
  const close = last[CLOSE] as number;
  const r = (side === "buy" ? close - entry : entry - close) / riskPrice;
  return { index, t1: end - 1, label: 0, side, rMultiple: r - cost / riskPrice, timedOut: true };
}

/** How many events a series of `bars` can label at a given horizon. */
export function labelHorizonFits(bars: Bar[], index: number, horizonBars: number): boolean {
  return index + 1 + horizonBars <= bars.length;
}
