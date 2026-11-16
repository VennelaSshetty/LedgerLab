
import { performance } from "node:perf_hooks";

export type RequestTimingStart = {
  requestStartedAt: string;
  monotonicStartedAt: number;
};

export type RequestTimingEnd = {
  responseReceivedAt: string;
  durationMs: number;
};

/**
 * Captures both:
 * - Wall-clock time for the request's real-world start timestamp.
 * - Monotonic time for accurate elapsed-duration measurement.
 */
export function startRequestTiming(): RequestTimingStart {
  return {
    requestStartedAt: new Date().toISOString(),
    monotonicStartedAt: performance.now(),
  };
}

/**
 * Captures the completion timestamp and calculates elapsed duration
 * using the monotonic clock rather than wall-clock subtraction.
 */
export function finishRequestTiming(
  start: RequestTimingStart,
): RequestTimingEnd {
  return {
    responseReceivedAt: new Date().toISOString(),
    durationMs: performance.now() - start.monotonicStartedAt,
  };
}
