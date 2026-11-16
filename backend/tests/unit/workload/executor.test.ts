
import { describe, expect, it } from "vitest";

import { executeWithConcurrency } from "../../../src/workload/executor";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe("executeWithConcurrency", () => {
  it("does not exceed the configured concurrency", async () => {
    const items = [1, 2, 3, 4, 5, 6];
    let active = 0;
    let maximumActive = 0;

    const results = await executeWithConcurrency(
      items,
      2,
      async (item) => {
        active++;
        maximumActive = Math.max(maximumActive, active);

        await new Promise((resolve) => setTimeout(resolve, 5));

        active--;

        return item * 2;
      },
    );

    expect(maximumActive).toBe(2);
    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
  });

  it("preserves input order when operations finish out of order", async () => {
    const items = [0, 1, 2, 3];

    const results = await executeWithConcurrency(
      items,
      4,
      async (item) => {
        const delays = [30, 5, 20, 10];

        await new Promise((resolve) =>
          setTimeout(resolve, delays[item]),
        );

        return `result-${item}`;
      },
    );

    expect(results).toEqual([
      "result-0",
      "result-1",
      "result-2",
      "result-3",
    ]);
  });

  it("executes every item exactly once", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const executed: string[] = [];

    await executeWithConcurrency(items, 3, async (item) => {
      executed.push(item);
      return item;
    });

    expect(executed).toHaveLength(items.length);
    expect([...executed].sort()).toEqual([...items].sort());
  });

  it("passes each item's original index to the callback", async () => {
    const items = ["a", "b", "c"];

    const results = await executeWithConcurrency(
      items,
      2,
      async (item, index) => `${index}:${item}`,
    );

    expect(results).toEqual(["0:a", "1:b", "2:c"]);
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    "rejects invalid concurrency value %s",
    async (concurrency) => {
      await expect(
        executeWithConcurrency([1, 2], concurrency, async (item) => item),
      ).rejects.toThrow("Concurrency must be a positive integer.");
    },
  );

  it("returns an empty array for empty input", async () => {
    const execute = async (item: number) => item * 2;

    const results = await executeWithConcurrency([], 3, execute);

    expect(results).toEqual([]);
  });

  it("supports concurrency greater than the number of items", async () => {
    const results = await executeWithConcurrency(
      [1, 2],
      10,
      async (item) => item * 2,
    );

    expect(results).toEqual([2, 4]);
  });

  it("propagates an execution error and does not assign new work", async () => {
    const inFlight = createDeferred<number>();
    const started: number[] = [];

    const execution = executeWithConcurrency(
      [0, 1, 2, 3],
      2,
      async (item) => {
        started.push(item);

        if (item === 0) {
          throw new Error("Simulated execution failure");
        }

        if (item === 1) {
          return inFlight.promise;
        }

        return item;
      },
    );

    // Allow the first worker's failure to be processed.
    await Promise.resolve();
    await Promise.resolve();

    // Item 0 failed; item 1 is still running.
    // No additional items should have been assigned.
    expect(started).toEqual([0, 1]);

    // The executor must wait for the already-running operation.
    let settled = false;

    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Promise.resolve();

    expect(settled).toBe(false);

    // Allow the in-flight operation to finish.
    inFlight.resolve(1);

    await expect(execution).rejects.toThrow(
      "Simulated execution failure",
    );

    expect(started).toEqual([0, 1]);
  });
});
