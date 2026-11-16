import { generateWorkload } from "../../../src/workload/generator";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runWorkload,
  runWorkloadOverHttp,
} from "../../../src/history/runner";
import type { WorkloadConfig } from "../../../src/workload/types";

function createTestWorkload() {
  const config: WorkloadConfig = {
    seed: 12345,
    accountCount: 2,
    transferCount: 4,
    minAmountPaise: "100",
    maxAmountPaise: "1000",
    invalidRequestPercentage: 0,
    concurrency: 2,
  };

  return generateWorkload(config, ["account-1", "account-2"]);
}

describe("runWorkload", () => {
  it("executes all transfers and preserves their input order", async () => {
    const workload = createTestWorkload();

    const results = await runWorkload(
      workload,
      async (_transfer, index) => {
        await new Promise((resolve) =>
          setTimeout(resolve, (4 - index) * 5),
        );

        return `result-${index}`;
      },
    );

    expect(results).toHaveLength(workload.transfers.length);

    results.forEach((result, index) => {
      expect(result.transfer.requestId).toBe(
        workload.transfers[index].requestId,
      );

      expect(result.result).toBe(`result-${index}`);
      expect(result.error).toBeUndefined();
    });
  });

  it("records timing information for every executed transfer", async () => {
    const workload = createTestWorkload();

    const results = await runWorkload(
      workload,
      async () => "success",
    );

    for (const result of results) {
      expect(
        new Date(result.requestStartedAt).toISOString(),
      ).toBe(result.requestStartedAt);

      expect(
        new Date(result.responseReceivedAt).toISOString(),
      ).toBe(result.responseReceivedAt);

      expect(Number.isFinite(result.durationMs)).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("captures individual execution errors without stopping the workload", async () => {
    const workload = createTestWorkload();

    const executedIndexes: number[] = [];

    const results = await runWorkload(
      workload,
      async (_transfer, index) => {
        executedIndexes.push(index);

        if (index === 1) {
          throw new Error("Simulated request failure");
        }

        return `result-${index}`;
      },
    );

    expect(executedIndexes).toHaveLength(4);
    expect(results).toHaveLength(4);

    expect(results[1].error).toBeInstanceOf(Error);
    expect(results[1].result).toBeUndefined();

    expect(results[0].result).toBe("result-0");
    expect(results[2].result).toBe("result-2");
    expect(results[3].result).toBe("result-3");
  });


  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Safe Mode requests with request, correlation and idempotency headers", async () => {
    const workload = createTestWorkload();

   const mockFetch = vi.fn(
  async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({
  transfer: {
    id: "transfer-123",
    status: "COMPLETED",
  },
}), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
);

    vi.stubGlobal("fetch", mockFetch);

    const results = await runWorkloadOverHttp(
      workload,
      "SAFE",
      "http://localhost:5000",
    );

    expect(results).toHaveLength(4);
    expect(mockFetch).toHaveBeenCalledTimes(4);

const firstCall = mockFetch.mock.calls[0];
const headers = new Headers(firstCall[1]?.headers);
    
   expect(firstCall[0]).toEqual(
  new URL("http://localhost:5000/api/transfers"),
);

expect(headers.get("X-Request-ID")).toBe(
  workload.transfers[0].requestId,
);

expect(headers.get("X-Correlation-ID")).toBe(
  workload.transfers[0].correlationId,
);

expect(headers.get("Idempotency-Key")).toBe(
  workload.transfers[0].idempotencyKey,
);

expect(results[0].result?.httpStatus).toBe(201);

expect(results[0].result?.transferId).toBe("transfer-123");

expect(results[0].result?.responseBody).toEqual({
  transfer: {
    id: "transfer-123",
    status: "COMPLETED",
  },
});
  });

  it("sends Naive Mode requests without an idempotency header", async () => {
    const workload = createTestWorkload();

   const mockFetch = vi.fn(
  async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({
  transfer: {
    id: "transfer-123",
    status: "COMPLETED",
  },
}), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
);

    vi.stubGlobal("fetch", mockFetch);

    const results = await runWorkloadOverHttp(
      workload,
      "NAIVE",
      "http://localhost:5000",
    );

    expect(results).toHaveLength(4);
    expect(mockFetch).toHaveBeenCalledTimes(4);

  const firstCall = mockFetch.mock.calls[0];
const headers = new Headers(firstCall[1]?.headers);

expect(firstCall[0]).toEqual(
  new URL("http://localhost:5000/api/naive-transfers"),
);

expect(headers.get("X-Request-ID")).toBe(
  workload.transfers[0].requestId,
);

expect(headers.get("X-Correlation-ID")).toBe(
  workload.transfers[0].correlationId,
);

expect(headers.get("Idempotency-Key")).toBeNull();

expect(results[0].result?.httpStatus).toBe(201);

expect(results[0].result?.transferId).toBe("transfer-123");

expect(results[0].result?.responseBody).toEqual({
  transfer: {
    id: "transfer-123",
    status: "COMPLETED",
  },
});
  });

  it("records HTTP 200 responses and original transfer IDs for Safe Mode replays", async () => {
  const workload = createTestWorkload();

  const mockFetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          transfer: {
            id: "original-transfer-123",
            status: "COMPLETED",
          },
          replayed: true,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
  );

  vi.stubGlobal("fetch", mockFetch);

  const results = await runWorkloadOverHttp(
    workload,
    "SAFE",
    "http://localhost:5000",
  );

  expect(results[0].result?.httpStatus).toBe(200);
  expect(results[0].result?.transferId).toBe(
    "original-transfer-123",
  );

  expect(results[0].result?.responseBody).toMatchObject({
    replayed: true,
  });
  });

  
it("records Safe Mode validation failures with their error code and message", async () => {
  const workload = createTestWorkload();

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "INSUFFICIENT_FUNDS",
            message: "The transfer request could not be completed.",
          },
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ),
  );

  const results = await runWorkloadOverHttp(
    workload,
    "SAFE",
    "http://localhost:5000",
  );

  expect(results[0].result?.httpStatus).toBe(409);
  expect(results[0].historyError).toEqual({
    type: "HTTP_ERROR",
    code: "INSUFFICIENT_FUNDS",
    message: "The transfer request could not be completed.",
  });
});

it("records Naive Mode validation failures with their string error format", async () => {
  const workload = createTestWorkload();

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: "INVALID_AMOUNT",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ),
  );

  const results = await runWorkloadOverHttp(
    workload,
    "NAIVE",
    "http://localhost:5000",
  );

  expect(results[0].result?.httpStatus).toBe(400);
  expect(results[0].historyError).toEqual({
    type: "HTTP_ERROR",
    code: "INVALID_AMOUNT",
    message: "INVALID_AMOUNT",
  });
});

it("preserves Safe Mode service errors and commit-outcome-unknown details", async () => {
  const workload = createTestWorkload();

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "TRANSFER_COMMIT_OUTCOME_UNKNOWN",
            message:
              "The transfer outcome could not be confirmed. Retry the request using the same idempotency key.",
          },
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ),
  );

  const results = await runWorkloadOverHttp(
    workload,
    "SAFE",
    "http://localhost:5000",
  );

  expect(results[0].result?.httpStatus).toBe(503);
  expect(results[0].historyError).toEqual({
    type: "HTTP_ERROR",
    code: "TRANSFER_COMMIT_OUTCOME_UNKNOWN",
    message:
      "The transfer outcome could not be confirmed. Retry the request using the same idempotency key.",
  });
});

it("records connection failures when no HTTP response is received", async () => {
  const workload = createTestWorkload();

  const connectionError = Object.assign(
    new TypeError("fetch failed"),
    {
      cause: Object.assign(
        new Error("connect ECONNREFUSED"),
        { code: "ECONNREFUSED" },
      ),
    },
  );

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw connectionError;
    }),
  );

  const results = await runWorkloadOverHttp(
    workload,
    "SAFE",
    "http://localhost:5000",
  );

  expect(results).toHaveLength(4);

  expect(results[0].result).toBeUndefined();
  expect(results[0].result?.httpStatus).toBeUndefined();

  expect(results[0].historyError).toEqual({
    type: "CONNECTION_ERROR",
    code: "ECONNREFUSED",
    message: "fetch failed",
  });

  expect(results[0].error).toBe(connectionError);
});


it("records timeouts with an unknown transfer outcome", async () => {
  const workload = createTestWorkload();

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;

        signal?.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        );
      });
    }),
  );

  const results = await runWorkloadOverHttp(
    workload,
    "SAFE",
    "http://localhost:5000",
    10,
  );

  expect(results).toHaveLength(4);

  expect(results[0].historyError?.type).toBe("TIMEOUT");
  expect(results[0].outcome).toBe("TIMEOUT");
  expect(results[0].transferOutcome).toBe("UNKNOWN");
  expect(results[0].result).toBeUndefined();
});

it("classifies successful responses as confirmed committed", async () => {
  const workload = createTestWorkload();

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          transfer: {
            id: "transfer-123",
            status: "COMPLETED",
          },
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ),
  );

  const results = await runWorkloadOverHttp(
    workload,
    "SAFE",
    "http://localhost:5000",
  );

  expect(results[0].outcome).toBe("SUCCESS");
  expect(results[0].transferOutcome).toBe(
    "CONFIRMED_COMMITTED",
  );
});

it("classifies validation responses as confirmed not committed", async () => {
  const workload = createTestWorkload();

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "INSUFFICIENT_FUNDS",
            message: "Insufficient funds.",
          },
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ),
  );

  const results = await runWorkloadOverHttp(
    workload,
    "SAFE",
    "http://localhost:5000",
  );

  expect(results[0].outcome).toBe("FAILURE");
  expect(results[0].transferOutcome).toBe(
    "CONFIRMED_NOT_COMMITTED",
  );
});

it("keeps commit-outcome-unknown responses as unknown", async () => {
  const workload = createTestWorkload();

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "TRANSFER_COMMIT_OUTCOME_UNKNOWN",
            message: "Transfer outcome is unknown.",
          },
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ),
  );

  const results = await runWorkloadOverHttp(
    workload,
    "SAFE",
    "http://localhost:5000",
  );

  expect(results[0].outcome).toBe("FAILURE");
  expect(results[0].transferOutcome).toBe("UNKNOWN");
});

it("keeps connection failures as unknown transfer outcomes", async () => {
  const workload = createTestWorkload();

  const connectionError = Object.assign(
    new TypeError("fetch failed"),
    {
      cause: Object.assign(
        new Error("connect ECONNREFUSED"),
        { code: "ECONNREFUSED" },
      ),
    },
  );

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw connectionError;
    }),
  );

  const results = await runWorkloadOverHttp(
    workload,
    "SAFE",
    "http://localhost:5000",
  );

  expect(results[0].outcome).toBe("UNKNOWN");
  expect(results[0].transferOutcome).toBe("UNKNOWN");
  expect(results[0].historyError?.type).toBe("CONNECTION_ERROR");
});


});
