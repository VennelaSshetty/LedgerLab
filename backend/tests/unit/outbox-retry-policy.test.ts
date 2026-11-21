
import { describe, it, expect } from "vitest";

import {
  RETRY_POLICY,
  calculateRetryDelayMs,
} from "../../src/services/outbox-retry-policy";

describe("Outbox retry policy", () => {
  it("uses exponential backoff with equal jitter", () => {
    // random = 0 gives the minimum equal-jitter delay (50%).
    expect(calculateRetryDelayMs(1, () => 0)).toBe(500);
    expect(calculateRetryDelayMs(2, () => 0)).toBe(1000);
    expect(calculateRetryDelayMs(3, () => 0)).toBe(2000);
    expect(calculateRetryDelayMs(4, () => 0)).toBe(4000);
    expect(calculateRetryDelayMs(5, () => 0)).toBe(8000);
  });

  it("calculates the maximum equal-jitter delay", () => {
    // random = 0.999... gives a value just below the full delay.
    expect(calculateRetryDelayMs(1, () => 0.999)).toBe(999);
    expect(calculateRetryDelayMs(3, () => 0.999)).toBe(3998);
  });

  it("caps exponential backoff at the maximum delay", () => {
    // The exponential delay is capped at 60 seconds.
    // With random = 0, equal jitter produces 30 seconds.
    expect(calculateRetryDelayMs(7, () => 0)).toBe(30_000);
    expect(calculateRetryDelayMs(10, () => 0)).toBe(30_000);
  });

  it("keeps jitter within the expected bounds", () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const delay = calculateRetryDelayMs(attempt, () => 0.5);

      const exponentialDelay = Math.min(
        RETRY_POLICY.baseDelayMs * 2 ** (attempt - 1),
        RETRY_POLICY.maxDelayMs,
      );

      expect(delay).toBeGreaterThanOrEqual(exponentialDelay / 2);
      expect(delay).toBeLessThanOrEqual(exponentialDelay);
    }
  });

  it("rejects invalid attempt numbers", () => {
    expect(() => calculateRetryDelayMs(0)).toThrow();
    expect(() => calculateRetryDelayMs(-1)).toThrow();
    expect(() => calculateRetryDelayMs(1.5)).toThrow();
  });

  it("rejects invalid random values", () => {
    expect(() => calculateRetryDelayMs(1, () => -0.1)).toThrow();
    expect(() => calculateRetryDelayMs(1, () => 1)).toThrow();
    expect(() => calculateRetryDelayMs(1, () => Number.NaN)).toThrow();
  });
});
