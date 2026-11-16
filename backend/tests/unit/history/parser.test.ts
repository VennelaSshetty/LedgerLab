import { describe, it, expect } from "vitest";
import {
  isHistoryRecord,
  parseHistoryContent,
} from "../../../src/history/parser";
import type { HistoryRecord } from "../../../src/history/types";

function createTestRecord(index: number): HistoryRecord {
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
    requestStartedAt: "2026-11-17T10:00:00.000Z",
    responseReceivedAt: "2026-11-17T10:00:00.010Z",
    durationMs: 10,
    httpStatus: 201,
    outcome: "SUCCESS",
    transferOutcome: "CONFIRMED_COMMITTED",
    transferId: `transfer-${index}`,
    timeoutMs: 10000,
    error: null,
  };
}

describe("History parser", () => {
  it("recognizes a valid history record", () => {
    expect(isHistoryRecord(createTestRecord(1))).toBe(true);
  });

  it("parses multiple JSONL records", () => {
    const content = [
      JSON.stringify(createTestRecord(1)),
      JSON.stringify(createTestRecord(2)),
    ].join("\n");

    const result = parseHistoryContent(content);

    expect(result.records).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it("ignores blank lines", () => {
    const content = [
      JSON.stringify(createTestRecord(1)),
      "",
      "   ",
      JSON.stringify(createTestRecord(2)),
      "",
    ].join("\n");

    const result = parseHistoryContent(content);

    expect(result.records).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it("reports malformed JSON without losing valid records", () => {
    const content = [
      JSON.stringify(createTestRecord(1)),
      "{invalid json",
      JSON.stringify(createTestRecord(2)),
    ].join("\n");

    const result = parseHistoryContent(content);

    expect(result.records).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].lineNumber).toBe(2);
  });

  it("rejects JSON with an invalid history schema", () => {
    const invalidRecord = {
      ...createTestRecord(1),
      outcome: "MAYBE",
    };

    const result = parseHistoryContent(
      JSON.stringify(invalidRecord),
    );

    expect(result.records).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("schema");
  });

  it("rejects records with invalid duration values", () => {
    const invalidRecord = {
      ...createTestRecord(1),
      durationMs: -10,
    };

    expect(isHistoryRecord(invalidRecord)).toBe(false);
  });

  it("rejects records with an invalid error structure", () => {
    const invalidRecord = {
      ...createTestRecord(1),
      error: {
        type: "HTTP_ERROR",
        code: 123,
        message: "Something failed",
      },
    };

    expect(isHistoryRecord(invalidRecord)).toBe(false);
  });

  it("returns empty results for an empty file", () => {
    const result = parseHistoryContent("");

    expect(result.records).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});