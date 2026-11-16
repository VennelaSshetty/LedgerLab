
import type {
  InvalidReason,
} from "../workload/types";

/**
 * Identifies which transfer implementation handled the request.
 */
export type ExecutionMode = "SAFE" | "NAIVE";

/**
 * Describes what the HTTP client observed.
 *
 * This does not independently establish whether the database committed.
 */
export type RequestOutcome =
  | "SUCCESS"
  | "FAILURE"
  | "TIMEOUT"
  | "UNKNOWN";

/**
 * Describes what is known about the database transfer.
 */
export type TransferOutcome =
  | "CONFIRMED_COMMITTED"
  | "CONFIRMED_NOT_COMMITTED"
  | "UNKNOWN";

/**
 * Identifies the category of an error encountered during execution.
 */
export type HistoryErrorType =
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "CONNECTION_ERROR"
  | "CLIENT_ERROR"
  | "UNKNOWN_ERROR";

/**
 * Structured error details.
 *
 * The error code may be unavailable, but a human-readable
 * error message must always be provided.
 */
export type HistoryError = {
  type: HistoryErrorType;
  code: string | null;
  message: string;
};

/**
 * Complete execution history for one generated transfer request.
 *
 * One HistoryRecord represents one request attempt and its final
 * observed outcome. It does not guarantee that the database outcome
 * is known.
 */
export type HistoryRecord = {
  /**
   * Schema version allows the history format to evolve safely.
   */
  recordVersion: 1;

  /**
   * Request identity and execution mode.
   */
  requestId: string;
  correlationId: string;
  idempotencyKey: string | null;
  mode: ExecutionMode;

  /**
   * Original generated transfer details.
   * Monetary amounts remain integer strings in paise.
   */
  fromAccountId: string;
  toAccountId: string;
  amountPaise: string;

  /**
   * What the workload generator expected.
   */
  expectedValidity: "VALID" | "INVALID";
  invalidReason: InvalidReason | null;

  /**
   * Wall-clock timestamps in ISO 8601 format.
   */
  requestStartedAt: string;
  responseReceivedAt: string | null;

  /**
   * Duration measured with a monotonic clock.
   */
  durationMs: number;

  /**
   * HTTP response information.
   */
  httpStatus: number | null;

  /**
   * Actual observed request outcome and database outcome.
   */
  outcome: RequestOutcome;
  transferOutcome: TransferOutcome;

  /**
   * Transfer ID, if the server returned one.
   */
  transferId: string | null;

  /**
   * Configured client timeout for this request, in milliseconds.
   */
  timeoutMs: number;

  /**
   * Error details, or null when no error occurred.
   */
  error: HistoryError | null;
};
