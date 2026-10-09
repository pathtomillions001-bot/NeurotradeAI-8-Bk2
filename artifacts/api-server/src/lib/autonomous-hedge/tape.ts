/**
 * Autonomous engine — tape reader.
 *
 * Reads the market's digit tape (lib/digit-tape.ts) and returns the last N
 * ticks with their monotonic sequence and provenance. The ranker never sees a
 * tick that the tape has not accepted, and `live` tells the caller whether the
 * tape came from the broker or from the simulator.
 */

import { tickManager } from "../deriv";
import { HEDGE_WINDOW } from "./constants";

export interface HedgeTape {
  symbol: string;
  digits: number[];
  prices: number[];
  /** Sequence of the newest tick in this tape (monotonic per symbol+generation). */
  tickSequence: number;
  /** Epoch seconds of the newest tick. */
  newestEpoch: number;
  /** True only when every tick in the window came from the live broker feed. */
  live: boolean;
  /** Milliseconds since the newest tick was received. */
  ageMs: number;
}

export function readHedgeTape(symbol: string, window = HEDGE_WINDOW): HedgeTape | null {
  const snapshot = tickManager.getDigitSnapshot(symbol, window + 1);
  if (!snapshot) return null;
  const newest = snapshot.tick;
  // A tape generation boundary (feed gap, source switch) invalidates older ticks.
  const current = snapshot.ticks.filter(
    (t) => t.generation === newest.generation && t.source === newest.source,
  );
  const tail = current.slice(-window);
  if (tail.length === 0) return null;
  const last = tail[tail.length - 1];
  return {
    symbol,
    digits: tail.map((t) => t.digit),
    prices: tail.map((t) => t.price),
    tickSequence: last.sequence,
    newestEpoch: last.epoch,
    live: tail.every((t) => t.source === "live"),
    ageMs: Math.max(0, Date.now() - last.receivedAt),
  };
}
