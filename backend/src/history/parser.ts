import { readFile } from "node:fs/promises";
import type {
  HistoryError,
  HistoryRecord,
} from "./types";
import type { InvalidReason } from "../workload/types";

export type HistoryParseError = {
  lineNumber: number;
  line: string;
  message: string;
};

export type HistoryParseResult = {
  records: HistoryRecord[];
  errors: HistoryParseError[];
};

const INVALID_REASONS: InvalidReason[] = [
  "SAME_ACCOUNT",
  "MALFORMED_ACCOUNT_ID",
  "NONEXISTENT_ACCOUNT",
  "ZERO_AMOUNT",
  "NEGATIVE_AMOUNT",
];

const REQUEST_OUTCOMES = [
  "SUCCESS",
  "FAILURE",
  "TIMEOUT",
  "UNKNOWN",
] as const;

const TRANSFER_OUTCOMES = [
  "CONFIRMED_COMMITTED",
  "CONFIRMED_NOT_COMMITTED",
  "UNKNOWN",
] as const;

const ERROR_TYPES = [
  "HTTP_ERROR",
  "TIMEOUT",
  "CONNECTION_ERROR",
  "CLIENT_ERROR",
  "UNKNOWN_ERROR",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isValidTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !Number.isNaN(Date.parse(value))
  );
}

function isHistoryError(value: unknown): value is HistoryError {
  if (!isObject(value)) {
    return false;
  }

  return (
    ERROR_TYPES.includes(value.type as (typeof ERROR_TYPES)[number]) &&
    isNullableString(value.code) &&
    typeof value.message === "string"
  );
}

export function isHistoryRecord(
  value: unknown,
): value is HistoryRecord {
  if (!isObject(value)) {
    return false;
  }

  return (
    value.recordVersion === 1 &&
    isNonEmptyString(value.requestId) &&
    isNonEmptyString(value.correlationId) &&
    isNullableString(value.idempotencyKey) &&
    (value.mode === "SAFE" || value.mode === "NAIVE") &&
    isNonEmptyString(value.fromAccountId) &&
    isNonEmptyString(value.toAccountId) &&
    typeof value.amountPaise === "string" &&
    (value.expectedValidity === "VALID" ||
      value.expectedValidity === "INVALID") &&
    (value.invalidReason === null ||
      INVALID_REASONS.includes(value.invalidReason as InvalidReason)) &&
    isValidTimestamp(value.requestStartedAt) &&
    (value.responseReceivedAt === null ||
      isValidTimestamp(value.responseReceivedAt)) &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0 &&
    (value.httpStatus === null ||
  (typeof value.httpStatus === "number" &&
    Number.isInteger(value.httpStatus) &&
    value.httpStatus >= 100 &&
    value.httpStatus <= 599))&&
    REQUEST_OUTCOMES.includes(
      value.outcome as (typeof REQUEST_OUTCOMES)[number],
    ) &&
    TRANSFER_OUTCOMES.includes(
      value.transferOutcome as (typeof TRANSFER_OUTCOMES)[number],
    ) &&
    isNullableString(value.transferId) &&
   typeof value.timeoutMs === "number" &&
Number.isInteger(value.timeoutMs) &&
value.timeoutMs > 0 &&
    (value.error === null || isHistoryError(value.error))
  );
}

export function parseHistoryContent(
  content: string,
): HistoryParseResult {
  const records: HistoryRecord[] = [];
  const errors: HistoryParseError[] = [];

  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.trim() === "") {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(line);

      if (!isHistoryRecord(parsed)) {
        errors.push({
          lineNumber: index + 1,
          line,
          message: "JSON value does not match the HistoryRecord schema.",
        });

        continue;
      }

      records.push(parsed);
    } catch (error: unknown) {
      errors.push({
        lineNumber: index + 1,
        line,
        message:
          error instanceof Error
            ? error.message
            : "Unknown JSON parsing error.",
      });
    }
  }

  return {
    records,
    errors,
  };
}

export async function readHistoryFile(
  filePath: string,
): Promise<HistoryParseResult> {
  const content = await readFile(filePath, "utf8");

  return parseHistoryContent(content);
}