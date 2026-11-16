
import { describe, expect, it } from "vitest";
import {
  finishRequestTiming,
  startRequestTiming,
} from "../../../src/history/timing";

describe("request timing", () => {
  it("captures valid UTC timestamps when a request starts and finishes", () => {
    const start = startRequestTiming();
    const end = finishRequestTiming(start);

    expect(new Date(start.requestStartedAt).toISOString()).toBe(
      start.requestStartedAt,
    );

    expect(new Date(end.responseReceivedAt).toISOString()).toBe(
      end.responseReceivedAt,
    );
  });

  it("measures elapsed duration using a monotonic clock", () => {
    const start = startRequestTiming();

    const end = finishRequestTiming(start);

    expect(typeof end.durationMs).toBe("number");
    expect(Number.isFinite(end.durationMs)).toBe(true);
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns the expected timing fields", () => {
    const start = startRequestTiming();
    const end = finishRequestTiming(start);

    expect(start).toHaveProperty("requestStartedAt");
    expect(start).toHaveProperty("monotonicStartedAt");

    expect(end).toHaveProperty("responseReceivedAt");
    expect(end).toHaveProperty("durationMs");
  });
});
