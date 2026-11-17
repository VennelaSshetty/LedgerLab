import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

describe("fast-check shrinking and reproducibility", () => {
  it("shrinks a failing property to a minimal counterexample", () => {
    const property = fc.property(
      fc.tuple(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
      ),
      ([left, right]) => left + right < 0,
    );

    const result = fc.check(property, {
      seed: 20261118,
      numRuns: 1,
    });

    expect(result.failed).toBe(true);
    expect(result.counterexample).toEqual([[0, 0]]);
    expect(result.numShrinks).toBeGreaterThan(0);
  });

 it("reproduces the same counterexample with the same seed and shrink path", () => {
  const seed = 123456;

  const property = fc.property(
    fc.tuple(
      fc.integer({ min: 0, max: 100 }),
      fc.integer({ min: 0, max: 100 }),
    ),
    ([left, right]) => left + right < 0,
  );

  const first = fc.check(property, {
    seed,
    numRuns: 1,
  });

  expect(first.failed).toBe(true);

  const second = fc.check(property, {
    seed,
    numRuns: 1,
    path: first.counterexamplePath ?? "",
  });

  expect(second.failed).toBe(true);
  expect(second.seed).toBe(seed);
  expect(second.counterexample).toEqual(first.counterexample);
  expect(second.counterexamplePath).toBe(first.counterexamplePath);
});
});
