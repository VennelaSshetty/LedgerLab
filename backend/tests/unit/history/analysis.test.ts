
import { describe, it, expect } from "vitest";
import type { HistoryRecord } from "../../../src/history/types";
import { buildHistoryIndexes } from "../../../src/history/indexes";
import {
  summarizeOutcomes,
  groupAttemptsByCorrelationId,
  calculateLatencyPercentiles,
  findSlowestRequests,
} from "../../../src/history/analysis";

function createRecord(
  index: number,
  overrides: Partial<HistoryRecord> = {},
): HistoryRecord {
  return {
    recordVersion: 1,
    requestId: `request-${index}`,
    correlationId: `correlation-${index}`,
    idempotencyKey: `key-${index}`,
    mode: "SAFE",
    fromAccountId: "account-001",
    toAccountId: "account-002",
    amountPaise: "10000",
    expectedValidity: "VALID",
    invalidReason: null,
    requestStartedAt: `2026-11-17T10:00:${String(index).padStart(2, "0")}.000Z`,
    responseReceivedAt: `2026-11-17T10:00:${String(index).padStart(2, "0")}.010Z`,
    durationMs: 10,
    httpStatus: 201,
    outcome: "SUCCESS",
    transferOutcome: "CONFIRMED_COMMITTED",
    transferId: `transfer-${index}`,
    timeoutMs: 10000,
    error: null,
    ...overrides,
  };
}

describe("History analysis", () => {
  describe("summarizeOutcomes", () => {
    it("counts request and transfer outcomes", () => {
      const records = [
        createRecord(1),
        createRecord(2, {
          outcome: "FAILURE",
          transferOutcome: "CONFIRMED_NOT_COMMITTED",
        }),
        createRecord(3, {
          outcome: "TIMEOUT",
          transferOutcome: "UNKNOWN",
        }),
        createRecord(4, {
          outcome: "UNKNOWN",
          transferOutcome: "UNKNOWN",
        }),
      ];

      const summary = summarizeOutcomes(records);

      expect(summary.totalRecords).toBe(4);

      expect(summary.requestOutcomes).toEqual({
        SUCCESS: 1,
        FAILURE: 1,
        TIMEOUT: 1,
        UNKNOWN: 1,
      });

      expect(summary.transferOutcomes).toEqual({
        CONFIRMED_COMMITTED: 1,
        CONFIRMED_NOT_COMMITTED: 1,
        UNKNOWN: 2,
      });
    });

    it("handles empty history", () => {
      const summary = summarizeOutcomes([]);

      expect(summary.totalRecords).toBe(0);
      expect(summary.requestOutcomes.SUCCESS).toBe(0);
      expect(summary.transferOutcomes.UNKNOWN).toBe(0);
    });
  });

  describe("groupAttemptsByCorrelationId", () => {
    it("groups multiple attempts for the same logical transfer", () => {
      const firstAttempt = createRecord(1, {
        requestId: "attempt-1",
        correlationId: "logical-transfer-1",
        requestStartedAt: "2026-11-17T10:00:01.000Z",
      });

      const secondAttempt = createRecord(2, {
        requestId: "attempt-2",
        correlationId: "logical-transfer-1",
        requestStartedAt: "2026-11-17T10:00:02.000Z",
      });

      const thirdAttempt = createRecord(3, {
        requestId: "attempt-3",
        correlationId: "logical-transfer-2",
      });

      const indexes = buildHistoryIndexes([
        secondAttempt,
        thirdAttempt,
        firstAttempt,
      ]);

      const groups = groupAttemptsByCorrelationId(indexes);

      const firstGroup = groups.find(
        (group) => group.correlationId === "logical-transfer-1",
      );

      expect(firstGroup).toBeDefined();
      expect(firstGroup?.attemptCount).toBe(2);

      expect(
        firstGroup?.attempts.map((record) => record.requestId),
      ).toEqual(["attempt-1", "attempt-2"]);
    });

    it("handles an empty correlation index", () => {
      const indexes = buildHistoryIndexes([]);

      expect(groupAttemptsByCorrelationId(indexes)).toEqual([]);
    });
  });

  describe("calculateLatencyPercentiles", () => {
    it("calculates nearest-rank P50, P95 and P99", () => {
      const records = [
        createRecord(1, { durationMs: 40 }),
        createRecord(2, { durationMs: 10 }),
        createRecord(3, { durationMs: 30 }),
        createRecord(4, { durationMs: 20 }),
      ];

      expect(calculateLatencyPercentiles(records)).toEqual({
        sampleCount: 4,
        p50: 20,
        p95: 40,
        p99: 40,
      });
    });

    it("handles a single latency sample", () => {
      const records = [
        createRecord(1, { durationMs: 75 }),
      ];

      expect(calculateLatencyPercentiles(records)).toEqual({
        sampleCount: 1,
        p50: 75,
        p95: 75,
        p99: 75,
      });
    });

    it("returns null percentiles for empty history", () => {
      expect(calculateLatencyPercentiles([])).toEqual({
        sampleCount: 0,
        p50: null,
        p95: null,
        p99: null,
      });
    });
  });

  describe("findSlowestRequests", () => {
    it("returns the K slowest requests in descending order", () => {
      const records = [
        createRecord(1, { durationMs: 50 }),
        createRecord(2, { durationMs: 10 }),
        createRecord(3, { durationMs: 90 }),
        createRecord(4, { durationMs: 30 }),
        createRecord(5, { durationMs: 70 }),
      ];

      const slowest = findSlowestRequests(records, 3);

      expect(
        slowest.map((record) => record.durationMs),
      ).toEqual([90, 70, 50]);
    });

    it("returns all records when K exceeds the record count", () => {
      const records = [
        createRecord(1, { durationMs: 20 }),
        createRecord(2, { durationMs: 40 }),
      ];

      const slowest = findSlowestRequests(records, 10);

      expect(slowest.map((record) => record.durationMs)).toEqual([
        40,
        20,
      ]);
    });

    it("returns an empty array when K is zero", () => {
      expect(findSlowestRequests([createRecord(1)], 0)).toEqual([]);
    });

    it("rejects negative or non-integer K", () => {
      expect(() => findSlowestRequests([], -1)).toThrow(
        "k must be a non-negative integer.",
      );

      expect(() => findSlowestRequests([], 1.5)).toThrow(
        "k must be a non-negative integer.",
      );
    });

    it("uses request ID as a deterministic tie-breaker", () => {
      const records = [
        createRecord(1, {
          requestId: "request-b",
          durationMs: 100,
        }),
        createRecord(2, {
          requestId: "request-a",
          durationMs: 100,
        }),
        createRecord(3, {
          requestId: "request-c",
          durationMs: 50,
        }),
      ];

      const slowest = findSlowestRequests(records, 2);

      expect(slowest.map((record) => record.requestId)).toEqual([
        "request-a",
        "request-b",
      ]);
    });
  });
});
