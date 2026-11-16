import { describe, it, expect } from "vitest";
import { buildHistoryIndexes } from "../../../src/history/indexes";
import type { HistoryRecord } from "../../../src/history/types";

function createTestRecord(
  requestId: string,
  correlationId: string,
  transferId: string | null,
): HistoryRecord {
  return {
    recordVersion: 1,
    requestId,
    correlationId,
    idempotencyKey: "test-key",
    mode: "SAFE",
    fromAccountId: "account-001",
    toAccountId: "account-002",
    amountPaise: "10000",
    expectedValidity: "VALID",
    invalidReason: null,
    requestStartedAt: "2026-11-17T10:00:00.000Z",
    responseReceivedAt: "2026-11-17T10:00:00.010Z",
    durationMs: 10,
    httpStatus: 201,
    outcome: "SUCCESS",
    transferOutcome: "CONFIRMED_COMMITTED",
    transferId,
    timeoutMs: 10000,
    error: null,
  };
}

describe("History correlation indexes", () => {
  it("indexes records by request ID", () => {
    const records = [
      createTestRecord("request-1", "correlation-1", "transfer-1"),
      createTestRecord("request-2", "correlation-2", "transfer-2"),
    ];

    const indexes = buildHistoryIndexes(records);

    expect(indexes.byRequestId.get("request-1")).toEqual([
      records[0],
    ]);

    expect(indexes.byRequestId.get("request-2")).toEqual([
      records[1],
    ]);
  });

  it("groups multiple attempts by correlation ID", () => {
    const records = [
      createTestRecord("request-1", "logical-transfer-1", "transfer-1"),
      createTestRecord("request-2", "logical-transfer-1", "transfer-1"),
      createTestRecord("request-3", "logical-transfer-2", "transfer-2"),
    ];

    const indexes = buildHistoryIndexes(records);

    expect(
      indexes.byCorrelationId.get("logical-transfer-1"),
    ).toEqual([records[0], records[1]]);

    expect(
      indexes.byCorrelationId.get("logical-transfer-2"),
    ).toEqual([records[2]]);
  });

  it("groups records by transfer ID", () => {
    const records = [
      createTestRecord("request-1", "correlation-1", "transfer-1"),
      createTestRecord("request-2", "correlation-2", "transfer-1"),
      createTestRecord("request-3", "correlation-3", "transfer-2"),
    ];

    const indexes = buildHistoryIndexes(records);

    expect(indexes.byTransferId.get("transfer-1")).toEqual([
      records[0],
      records[1],
    ]);

    expect(indexes.byTransferId.get("transfer-2")).toEqual([
      records[2],
    ]);
  });

  it("does not index null transfer IDs", () => {
    const records = [
      createTestRecord("request-1", "correlation-1", null),
    ];

    const indexes = buildHistoryIndexes(records);

    expect(indexes.byTransferId.size).toBe(0);
  });

  it("preserves duplicate request IDs instead of overwriting records", () => {
    const records = [
      createTestRecord("duplicate-request", "correlation-1", "transfer-1"),
      createTestRecord("duplicate-request", "correlation-2", "transfer-2"),
    ];

    const indexes = buildHistoryIndexes(records);

    expect(
      indexes.byRequestId.get("duplicate-request"),
    ).toEqual(records);
  });

  it("returns empty indexes for an empty history", () => {
    const indexes = buildHistoryIndexes([]);

    expect(indexes.byRequestId.size).toBe(0);
    expect(indexes.byCorrelationId.size).toBe(0);
    expect(indexes.byTransferId.size).toBe(0);
  });
});