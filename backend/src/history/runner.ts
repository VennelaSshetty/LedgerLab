import { executeWithConcurrency } from "../workload/executor";
import type {
  GeneratedWorkload,
  WorkloadTransfer,
} from "../workload/types";
import {
  finishRequestTiming,
  startRequestTiming,
} from "./timing";
import type {
  ExecutionMode,
  HistoryError,
  RequestOutcome,
  TransferOutcome,
} from "./types";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

export type HttpResponseData = {
  httpStatus: number;
  responseBody: unknown;
  transferId: string | null;
};

export type WorkloadExecutionResult<T> = {
  transfer: WorkloadTransfer;
  requestStartedAt: string;
  responseReceivedAt: string;
  durationMs: number;
  result?: T;
  error?: unknown;
};

export type HttpWorkloadExecutionResult =
  WorkloadExecutionResult<HttpResponseData> & {
    historyError: HistoryError | null;
    outcome: RequestOutcome;
    transferOutcome: TransferOutcome;
  };

export type RequestExecutor<T> = (
  transfer: WorkloadTransfer,
  index: number,
) => Promise<T>;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_HTTP_CONNECTIONS = 100;

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export async function runWorkload<T>(
  workload: GeneratedWorkload,
  executeRequest: RequestExecutor<T>,
): Promise<WorkloadExecutionResult<T>[]> {
  return executeWithConcurrency(
    workload.transfers,
    workload.config.concurrency,
    async (transfer, index) => {
      const start = startRequestTiming();

      try {
        const result = await executeRequest(transfer, index);
        const end = finishRequestTiming(start);

        return {
          transfer,
          requestStartedAt: start.requestStartedAt,
          responseReceivedAt: end.responseReceivedAt,
          durationMs: end.durationMs,
          result,
        };
      } catch (error: unknown) {
        const end = finishRequestTiming(start);

        return {
          transfer,
          requestStartedAt: start.requestStartedAt,
          responseReceivedAt: end.responseReceivedAt,
          durationMs: end.durationMs,
          error,
        };
      }
    },
  );
}

function extractTransferId(responseBody: unknown): string | null {
  if (
    typeof responseBody !== "object" ||
    responseBody === null ||
    !("transfer" in responseBody)
  ) {
    return null;
  }

  const transfer = responseBody.transfer;

  if (
    typeof transfer !== "object" ||
    transfer === null ||
    !("id" in transfer) ||
    typeof transfer.id !== "string"
  ) {
    return null;
  }

  return transfer.id;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  if ("code" in error && typeof error.code === "string") {
    return error.code;
  }

  if ("cause" in error) {
    return getErrorCode(error.cause);
  }

  return null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isTimeoutError(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "TimeoutError"
  ) {
    return true;
  }

  const code = getErrorCode(error);

  return code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT";
}

function classifyThrownError(error: unknown): HistoryError {
  const code = getErrorCode(error);

  if (isTimeoutError(error)) {
    return {
      type: "TIMEOUT",
      code,
      message: getErrorMessage(error),
    };
  }

  const isConnectionError =
    (code !== null && CONNECTION_ERROR_CODES.has(code)) ||
    error instanceof TypeError;

  return {
    type: isConnectionError
      ? "CONNECTION_ERROR"
      : "UNKNOWN_ERROR",
    code,
    message: getErrorMessage(error),
  };
}

function classifyHttpError(
  status: number,
  responseBody: unknown,
): HistoryError {
  let code: string | null = null;
  let message = `HTTP request failed with status ${status}.`;

  if (
    typeof responseBody === "object" &&
    responseBody !== null &&
    "error" in responseBody
  ) {
    const errorBody = responseBody.error;

    if (typeof errorBody === "string") {
      if (/^[A-Z][A-Z0-9_]*$/.test(errorBody)) {
        code = errorBody;
      }

      message = errorBody;
    } else if (
      typeof errorBody === "object" &&
      errorBody !== null
    ) {
      if (
        "code" in errorBody &&
        typeof errorBody.code === "string"
      ) {
        code = errorBody.code;
      }

      if (
        "message" in errorBody &&
        typeof errorBody.message === "string"
      ) {
        message = errorBody.message;
      }
    }
  }

  return {
    type: "HTTP_ERROR",
    code,
    message,
  };
}

function classifyTransferOutcome(
  status: number | null,
  historyError: HistoryError | null,
): TransferOutcome {
  if (status === null || historyError?.type === "TIMEOUT" ||
      historyError?.type === "CONNECTION_ERROR" ||
      historyError?.type === "UNKNOWN_ERROR") {
    return "UNKNOWN";
  }

  if (status >= 200 && status < 300) {
    return "CONFIRMED_COMMITTED";
  }

  if (status >= 400 && status < 500) {
    return "CONFIRMED_NOT_COMMITTED";
  }

  return "UNKNOWN";
}

function classifyRequestOutcome(
  status: number | null,
  historyError: HistoryError | null,
): RequestOutcome {
  if (historyError?.type === "TIMEOUT") {
    return "TIMEOUT";
  }

  if (status !== null) {
    return status >= 200 && status < 300
      ? "SUCCESS"
      : "FAILURE";
  }

  return "UNKNOWN";
}


export async function runWorkloadOverHttp(
  workload: GeneratedWorkload,
  mode: ExecutionMode,
  baseUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  maxConnections: number = DEFAULT_HTTP_CONNECTIONS,
): Promise<HttpWorkloadExecutionResult[]> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive integer.");
  }

  if (!Number.isInteger(maxConnections) || maxConnections <= 0) {
    throw new Error("maxConnections must be a positive integer.");
  }

  const endpoint =
    mode === "SAFE"
      ? "/api/transfers"
      : "/api/naive-transfers";

  const originalDispatcher = getGlobalDispatcher();

  const stressDispatcher = new Agent({
    connections: maxConnections,
    pipelining: 1,
  });

  setGlobalDispatcher(stressDispatcher);

  try {
    const results = await runWorkload(
      workload,
      async (transfer) => {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "X-Request-ID": transfer.requestId,
          "X-Correlation-ID": transfer.correlationId,
        };

        if (mode === "SAFE") {
          headers["Idempotency-Key"] = transfer.idempotencyKey;
        }

        const response = await fetch(new URL(endpoint, baseUrl), {
          method: "POST",
          headers,
          body: JSON.stringify({
            fromAccountId: transfer.fromAccountId,
            toAccountId: transfer.toAccountId,
            amountPaise: transfer.amountPaise,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        const responseBody = await readResponseBody(response);

        return {
          httpStatus: response.status,
          responseBody,
          transferId: extractTransferId(responseBody),
        };
      },
    );

    return results.map((result) => {
      let historyError: HistoryError | null = null;

      if (result.error !== undefined) {
        historyError = classifyThrownError(result.error);
      } else if (
        result.result &&
        (result.result.httpStatus < 200 ||
          result.result.httpStatus >= 300)
      ) {
        historyError = classifyHttpError(
          result.result.httpStatus,
          result.result.responseBody,
        );
      }

      const httpStatus = result.result?.httpStatus ?? null;

      return {
        ...result,
        historyError,
        outcome: classifyRequestOutcome(httpStatus, historyError),
        transferOutcome: classifyTransferOutcome(
          httpStatus,
          historyError,
        ),
      };
    });
  } finally {
    setGlobalDispatcher(originalDispatcher);
    await stressDispatcher.close();
  }
}

