
import { describe, expect, it } from "vitest";
import { createPrng } from "../../../src/workload/prng";

describe("createPrng", () => {
  it("produces the same sequence for the same seed", () => {
    const first = createPrng(12345);
    const second = createPrng(12345);

    const firstSequence = Array.from({ length: 10 }, () => first());
    const secondSequence = Array.from({ length: 10 }, () => second());

    expect(firstSequence).toEqual(secondSequence);
  });

  it("produces different sequences for different seeds", () => {
    const first = createPrng(12345);
    const second = createPrng(54321);

    const firstSequence = Array.from({ length: 10 }, () => first());
    const secondSequence = Array.from({ length: 10 }, () => second());

    expect(firstSequence).not.toEqual(secondSequence);
  });

  it("always produces values in the range [0, 1)", () => {
    const random = createPrng(42);

    for (let i = 0; i < 1000; i++) {
      const value = random();

      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("accepts zero as a valid seed", () => {
    const random = createPrng(0);

    expect(random()).toBeGreaterThanOrEqual(0);
    expect(random()).toBeLessThan(1);
  });

  it("rejects negative seeds", () => {
    expect(() => createPrng(-1)).toThrow(
      "Seed must be an unsigned 32-bit integer.",
    );
  });

  it("rejects decimal seeds", () => {
    expect(() => createPrng(1.5)).toThrow(
      "Seed must be an unsigned 32-bit integer.",
    );
  });

  it("rejects seeds larger than the unsigned 32-bit range", () => {
    expect(() => createPrng(0x100000000)).toThrow(
      "Seed must be an unsigned 32-bit integer.",
    );
  });
});
