
export const RETRY_POLICY = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxAttempts: 5,
  jitterEnabled: true,
} as const;

export function calculateRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("attempt must be a positive integer");
  }

  const exponentialDelayMs = Math.min(
    RETRY_POLICY.baseDelayMs * 2 ** (attempt - 1),
    RETRY_POLICY.maxDelayMs,
  );

  if (!RETRY_POLICY.jitterEnabled) {
    return exponentialDelayMs;
  }

  const randomValue = random();

  if (
    !Number.isFinite(randomValue) ||
    randomValue < 0 ||
    randomValue >= 1
  ) {
    throw new Error("random must return a value between 0 and 1");
  }

  // Equal jitter: delay is between 50% and 100%
  // of the calculated exponential delay.
  return Math.floor(
    exponentialDelayMs / 2 +
      randomValue * (exponentialDelayMs / 2),
  );
}
