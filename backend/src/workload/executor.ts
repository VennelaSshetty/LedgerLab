
/**
 * Executes items with a configurable maximum concurrency.
 *
 * Input order is preserved in the returned results, even when
 * individual operations complete in a different order.
 *
 * If an operation fails:
 * - No new items are assigned.
 * - Already-running operations are allowed to settle.
 * - The first execution error is propagated.
 */
export async function executeWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  execute: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer.");
  }

  const results = new Array<R>(items.length);

  let nextIndex = 0;
  let hasFailed = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (!hasFailed) {
      const currentIndex = nextIndex;

      if (currentIndex >= items.length) {
        return;
      }

      nextIndex++;

      try {
        results[currentIndex] = await execute(
          items[currentIndex],
          currentIndex,
        );
      } catch (error) {
        if (!hasFailed) {
          hasFailed = true;
          firstError = error;
        }

        return;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);

  const workers = Array.from(
    { length: workerCount },
    () => worker(),
  );

  await Promise.all(workers);

  if (hasFailed) {
    throw firstError;
  }

  return results;
}
