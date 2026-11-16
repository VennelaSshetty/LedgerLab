
/**
 * Creates a deterministic pseudo-random number generator using Mulberry32.
 *
 * The same seed always produces the same sequence of values.
 * Each generated value is in the range [0, 1).
 *
 * This generator is intended for reproducible workloads, not cryptography.
 */
export function createPrng(seed: number): () => number {
  if (
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff
  ) {
    throw new Error("Seed must be an unsigned 32-bit integer.");
  }

  let state = seed >>> 0;

  return function nextRandom(): number {
    let value = (state += 0x6d2b79f5);

    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
