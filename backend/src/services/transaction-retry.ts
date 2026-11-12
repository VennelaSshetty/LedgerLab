export function isRetryableTransactionError(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error)
  ) {
    return false;
  }

  const code = error.code;

  return code === "40P01" || code === "40001";
}

export function getRetryDelay(attempt: number): number {
  const baseDelay = 100;
  const maxDelay = 1000;

  const exponentialDelay = Math.min(
    maxDelay,
    baseDelay * 2 ** attempt
  );

  const jitter = Math.random() * exponentialDelay * 0.5;

  return Math.floor(exponentialDelay + jitter);
}

export async function withTransactionRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 4
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isLastAttempt = attempt === maxAttempts - 1;

      if (!isRetryableTransactionError(error) || isLastAttempt) {
        throw error;
      }

      const delay = getRetryDelay(attempt);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error("TRANSFER_RETRIES_EXHAUSTED");
}