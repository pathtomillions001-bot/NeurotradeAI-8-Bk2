/** Tick identity/provenance for execution-sensitive consumers. No broker I/O. */
export type DigitSource = "live" | "simulated";
export interface DigitTick {
  symbol: string;
  sequence: number;
  generation: number;
  source: DigitSource;
  epoch: number;
  receivedAt: number;
  digit: number;
  price: number;
}
export interface DigitSnapshot {
  tick: DigitTick;
  ticks: DigitTick[];
}

/**
 * Ring length, quote value and last digit are NOT clocks. A monotonic sequence
 * advances even when two consecutive ticks carry exactly the same digit/price.
 * Source transitions and missing live intervals invalidate the previous tape.
 */
export class DigitTape {
  private tapes = new Map<string, { sequence: number; generation: number; ticks: DigitTick[] }>();
  constructor(private readonly capacity = 5000) {}

  push(input: Omit<DigitTick, "sequence" | "generation">, expectedIntervalMs = 2000): DigitTick | null {
    if (!Number.isInteger(input.digit) || input.digit < 0 || input.digit > 9 ||
        !Number.isFinite(input.price) || input.price <= 0 || !Number.isFinite(input.epoch) ||
        !Number.isFinite(input.receivedAt)) return null;
    let tape = this.tapes.get(input.symbol);
    if (!tape) {
      tape = { sequence: 0, generation: 1, ticks: [] };
      this.tapes.set(input.symbol, tape);
    }
    const previous = tape.ticks.at(-1);
    if (previous?.source === "live" && input.source === "live" && input.epoch <= previous.epoch) return null;
    if (previous && (previous.source !== input.source ||
        (input.source === "live" && (input.epoch - previous.epoch) * 1000 > expectedIntervalMs * 3))) {
      tape.ticks = [];
      tape.generation++;
    }
    const tick = { ...input, sequence: ++tape.sequence, generation: tape.generation };
    tape.ticks.push(tick);
    if (tape.ticks.length > this.capacity) tape.ticks.shift();
    return { ...tick };
  }

  snapshot(symbol: string, count = this.capacity): DigitSnapshot | null {
    const tape = this.tapes.get(symbol);
    const tick = tape?.ticks.at(-1);
    if (!tick || !tape) return null;
    return { tick: { ...tick }, ticks: tape.ticks.slice(-count).map(t => ({ ...t })) };
  }
}

export function sameDigitTick(a: DigitTick, b: DigitTick | null | undefined): boolean {
  return !!b && a.symbol === b.symbol && a.sequence === b.sequence &&
    a.generation === b.generation && a.source === b.source;
}

/** Timestamp-merging preserves repeated digits and never appends a tick twice. */
export function mergeLiveDigitHistory(
  history: Array<{ epoch: number; digit: number }>, live: DigitSnapshot, limit = 4999,
): number[] {
  if (live.tick.source !== "live") throw new Error("Cannot merge broker history with simulated data");
  const byEpoch = new Map<number, number>();
  let previous = -Infinity;
  for (const sample of history) {
    if (!Number.isFinite(sample.epoch) || sample.epoch <= previous || !Number.isInteger(sample.digit) || sample.digit < 0 || sample.digit > 9) {
      throw new Error("Malformed / unordered broker history");
    }
    previous = sample.epoch;
    if (sample.epoch <= live.tick.epoch) byEpoch.set(sample.epoch, sample.digit);
  }
  for (const sample of live.ticks) {
    if (sample.source !== "live" || sample.generation !== live.tick.generation) throw new Error("Mixed-provenance digit tape");
    const existing = byEpoch.get(sample.epoch);
    if (existing !== undefined && existing !== sample.digit) throw new Error("History disagrees with the live tick");
    byEpoch.set(sample.epoch, sample.digit);
  }
  return [...byEpoch.entries()].sort((a, b) => a[0] - b[0]).slice(-limit).map(([, digit]) => digit);
}
