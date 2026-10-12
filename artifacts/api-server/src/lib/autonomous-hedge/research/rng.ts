/**
 * Recovery research harness — deterministic RNG.
 *
 * Every simulator and test in this folder draws randomness from a seeded
 * generator so a report is reproducible from its command line. mulberry32 is
 * a small, well-behaved 32-bit generator; it is plenty for Monte-Carlo
 * episode simulation (this is not cryptographic code, the point is
 * determinism and speed).
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  nextInt(n: number): number;
  /** Bernoulli trial with success probability p. */
  bernoulli(p: number): boolean;
}

export function mulberry32(seed: number): Rng {
  let a = (seed >>> 0) || 0x9e3779b9;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    nextInt: (n: number) => Math.floor(next() * n),
    bernoulli: (p: number) => next() < p,
  };
}

/** Split one seed into independent stream seeds (for parallel arms). */
export function splitSeed(seed: number, index: number): number {
  return (seed ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0;
}
