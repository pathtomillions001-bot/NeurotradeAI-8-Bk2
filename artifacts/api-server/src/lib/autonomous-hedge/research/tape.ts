/**
 * Recovery research harness — i.i.d. tape generator.
 *
 * Deriv synthetic indices come from a cryptographically secure RNG, so the
 * honest base-case tape is: digits uniform on 0–9, price a zero-drift random
 * walk whose tick direction is independent of everything before it. The
 * generator can also plant a structural edge (a biased stream on one
 * contract) for positive-control tests — clearly labelled, never the default.
 */

import type { Rng } from "./rng";

export interface TapeTick {
  digit: number;
  price: number;
}

export interface TapeGeneratorOptions {
  /** Starting price of the random walk. */
  startPrice?: number;
  /** Per-tick volatility of the random walk (relative). */
  volatility?: number;
  /**
   * Optional planted edge for positive controls. `digit` biases the digit
   * distribution toward `value` with probability mass `strength` (a fraction
   * of the uniform mass is moved onto `value`); `direction` biases the price
   * move sign. NEVER set for baseline runs.
   */
  plant?:
    | { kind: "digit"; value: number; strength: number }
    | { kind: "direction"; strength: number };
}

export interface TapeGenerator {
  /** Advance the tape by one tick and return it. */
  step(): TapeTick;
  /** Advance by n ticks, returning the appended ticks. */
  steps(n: number): TapeTick[];
  digits(): number[];
  prices(): number[];
  length(): number;
}

/**
 * Create a seeded i.i.d. tape. Each tick: digit uniform on 0–9; price moves by
 * a symmetric continuous increment so P(up) = P(down) = 0.5 exactly (no ties).
 */
export function createTapeGenerator(rng: Rng, options: TapeGeneratorOptions = {}): TapeGenerator {
  const startPrice = options.startPrice ?? 1000;
  const volatility = options.volatility ?? 0.0005;
  const plant = options.plant;

  const digitsArr: number[] = [];
  const pricesArr: number[] = [startPrice];

  const drawDigit = (): number => {
    if (plant?.kind === "digit") {
      // Move `strength` of the uniform mass onto the planted digit.
      const d = rng.nextInt(10);
      if (rng.next() < plant.strength) return plant.value;
      return d;
    }
    return rng.nextInt(10);
  };

  const step = (): TapeTick => {
    const digit = drawDigit();
    const last = pricesArr[pricesArr.length - 1];
    let sign = rng.next() < 0.5 ? -1 : 1;
    if (plant?.kind === "direction" && rng.next() < plant.strength) sign = 1;
    const magnitude = (0.5 + rng.next()) * volatility * last;
    const price = last + sign * magnitude;
    digitsArr.push(digit);
    pricesArr.push(price);
    return { digit, price };
  };

  return {
    step,
    steps(n: number): TapeTick[] {
      const out: TapeTick[] = [];
      for (let i = 0; i < n; i++) out.push(step());
      return out;
    },
    digits: () => digitsArr,
    prices: () => pricesArr.slice(1),
    length: () => digitsArr.length,
  };
}
