import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";

import request from "supertest";
import { randomUUID } from "node:crypto";

import app from "../../src/app";
import { pool } from "../../src/db/pool";
import { adminPool } from "../helpers/admin-pool";

import * as transfersService from "../../src/services/transfers.service";

let userId: string;
let senderId: string;
let receiverId: string;

describe("POST /api/transfers", () => {
  beforeEach(async () => {
    userId = randomUUID();
    senderId = randomUUID();
    receiverId = randomUUID();

    await adminPool.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, 'Route Test', $2, 'test-hash')`,
      [userId, `route-test-${userId}@ledgerlab.local`]
    );

    await adminPool.query(
      `INSERT INTO accounts (id, user_id, balance_paise)
       VALUES ($1, $3, 50000), ($2, $3, 10000)`,
      [senderId, receiverId, userId]
    );
  });

  afterEach(() => {
  vi.restoreAllMocks();
});

async function expectTransferError(
  errorCode: string,
  expectedStatus: number
) {
  vi.spyOn(transfersService, "createTransfer").mockRejectedValue(
    new Error(errorCode)
  );

  const response = await request(app)
    .post("/api/transfers")
    .set("Idempotency-Key", `route-error-${randomUUID()}`)
    .send({
      fromAccountId: senderId,
      toAccountId: receiverId,
      amountPaise: "20000",
    });

  expect(response.status).toBe(expectedStatus);

  expect(response.body).toEqual({
    error: {
      code: errorCode,
      message: "The transfer request could not be completed.",
    },
  });
}

  it("creates a transfer and returns HTTP 201", async () => {
    const response = await request(app)
      .post("/api/transfers")
      .set("Idempotency-Key", "route-success-001")
      .send({
        fromAccountId: senderId,
        toAccountId: receiverId,
        amountPaise: "20000",
      });

    expect(response.status).toBe(201);
    expect(response.body.transfer.status).toBe("COMPLETED");
    expect(response.body.replayed).toBe(false);
  });

  it("returns HTTP 200 when the same request is retried", async () => {
    const input = {
      fromAccountId: senderId,
      toAccountId: receiverId,
      amountPaise: "20000",
    };

    const first = await request(app)
      .post("/api/transfers")
      .set("Idempotency-Key", "route-retry-001")
      .send(input);

    const second = await request(app)
      .post("/api/transfers")
      .set("Idempotency-Key", "route-retry-001")
      .send(input);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.transfer.id).toBe(first.body.transfer.id);
  });

  it("returns HTTP 409 for insufficient funds", async () => {
    const response = await request(app)
      .post("/api/transfers")
      .set("Idempotency-Key", "route-insufficient-001")
      .send({
        fromAccountId: senderId,
        toAccountId: receiverId,
        amountPaise: "60000",
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INSUFFICIENT_FUNDS");
  });

  it("returns HTTP 409 when an idempotency key is reused with a different request", async () => {
    const first = await request(app)
      .post("/api/transfers")
      .set("Idempotency-Key", "route-key-reuse-001")
      .send({
        fromAccountId: senderId,
        toAccountId: receiverId,
        amountPaise: "20000",
      });

    const second = await request(app)
      .post("/api/transfers")
      .set("Idempotency-Key", "route-key-reuse-001")
      .send({
        fromAccountId: senderId,
        toAccountId: receiverId,
        amountPaise: "30000",
      });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("returns HTTP 400 when the idempotency key is missing", async () => {
    const response = await request(app)
      .post("/api/transfers")
      .send({
        fromAccountId: senderId,
        toAccountId: receiverId,
        amountPaise: "20000",
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
  error: {
    code: "IDEMPOTENCY_KEY_REQUIRED",
    message: "The Idempotency-Key header is required.",
  },
});
  });

it("returns 503 when the transfer COMMIT outcome is unknown", async () => {
  vi.spyOn(transfersService, "createTransfer").mockRejectedValue(
    new Error("TRANSFER_COMMIT_OUTCOME_UNKNOWN")
  );

  const response = await request(app)
    .post("/api/transfers")
    .set("Idempotency-Key", "uncertain-transfer-123")
    .send({
      fromAccountId: senderId,
      toAccountId: receiverId,
      amountPaise: "50000",
    });

  expect(response.status).toBe(503);

  expect(response.body).toEqual({
    error: {
      code: "TRANSFER_COMMIT_OUTCOME_UNKNOWN",
      message:
        "The transfer outcome could not be confirmed. Retry the request using the same idempotency key.",
    },
  });
});

// Additional POST error-handling tests

it("returns HTTP 400 for an invalid account ID", async () => {
  await expectTransferError("INVALID_ACCOUNT_ID", 400);
});

it("returns HTTP 400 when sender and receiver accounts are the same", async () => {
  await expectTransferError("SAME_ACCOUNT_TRANSFER", 400);
});

it("returns HTTP 400 for an invalid transfer amount", async () => {
  await expectTransferError("INVALID_AMOUNT", 400);
});

it("returns HTTP 400 for an invalid idempotency key", async () => {
  await expectTransferError("INVALID_IDEMPOTENCY_KEY", 400);
});

it("returns HTTP 404 when an account does not exist", async () => {
  await expectTransferError("ACCOUNT_NOT_FOUND", 404);
});

it("returns HTTP 409 when an account is inactive", async () => {
  await expectTransferError("ACCOUNT_NOT_ACTIVE", 409);
});

it("returns HTTP 503 when the database is unavailable", async () => {
  vi.spyOn(transfersService, "createTransfer").mockRejectedValue({
    code: "ECONNREFUSED",
  });

  const response = await request(app)
    .post("/api/transfers")
    .set("Idempotency-Key", `route-db-error-${randomUUID()}`)
    .send({
      fromAccountId: senderId,
      toAccountId: receiverId,
      amountPaise: "20000",
    });

  expect(response.status).toBe(503);

  expect(response.body).toEqual({
    error: {
      code: "SERVICE_UNAVAILABLE",
      message: "The service is temporarily unavailable. Please try again.",
    },
  });
});

it("returns HTTP 500 for an unexpected error", async () => {
  vi.spyOn(transfersService, "createTransfer").mockRejectedValue(
    new Error("Unexpected internal failure")
  );

  const response = await request(app)
    .post("/api/transfers")
    .set("Idempotency-Key", `route-unexpected-${randomUUID()}`)
    .send({
      fromAccountId: senderId,
      toAccountId: receiverId,
      amountPaise: "20000",
    });

  expect(response.status).toBe(500);

  expect(response.body).toEqual({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred.",
    },
  });
});

}); // End of POST describe;

describe("GET /api/transfers/:id/ledger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test 1: Invalid transfer ID
  it("returns HTTP 400 for an invalid transfer ID", async () => {
    const response = await request(app)
      .get("/api/transfers/invalid-id/ledger");

    expect(response.status).toBe(400);

    expect(response.body).toEqual({
      error: {
        code: "INVALID_TRANSFER_ID",
        message: "The transfer ID must be a valid UUID.",
      },
    });
  });

  // Test 2: Transfer does not exist
  it("returns HTTP 404 when the transfer does not exist", async () => {
    const nonExistentTransferId = randomUUID();

    const response = await request(app)
      .get(`/api/transfers/${nonExistentTransferId}/ledger`);

    expect(response.status).toBe(404);

    expect(response.body).toEqual({
      error: {
        code: "TRANSFER_NOT_FOUND",
        message: "The requested transfer could not be found.",
      },
    });
  });

  // Test 3: Database connection failure
  it("returns HTTP 503 when the database is unavailable", async () => {
    vi.spyOn(transfersService, "getTransferLedger").mockRejectedValue({
      code: "ECONNREFUSED",
    });

    const response = await request(app)
      .get(`/api/transfers/${randomUUID()}/ledger`);

    expect(response.status).toBe(503);

    expect(response.body).toEqual({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message:
          "The service is temporarily unavailable. Please try again.",
      },
    });
  });

  // Test 4: Unexpected error
  it("returns HTTP 500 when an unexpected error occurs", async () => {
    vi.spyOn(transfersService, "getTransferLedger").mockRejectedValue(
      new Error("Unexpected database query failure")
    );

    const response = await request(app)
      .get(`/api/transfers/${randomUUID()}/ledger`);

    expect(response.status).toBe(500);

    expect(response.body).toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
      },
    });
  });

  // Test 5: Successful ledger retrieval
  it("returns HTTP 200 with the transfer ledger entries", async () => {
    const testUserId = randomUUID();
    const testSenderId = randomUUID();
    const testReceiverId = randomUUID();

    await adminPool.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, 'Ledger Route Test', $2, 'test-hash')`,
      [testUserId, `ledger-route-${testUserId}@ledgerlab.local`]
    );

    await adminPool.query(
      `INSERT INTO accounts (id, user_id, balance_paise)
       VALUES ($1, $3, 50000), ($2, $3, 10000)`,
      [testSenderId, testReceiverId, testUserId]
    );

    const transferResponse = await request(app)
      .post("/api/transfers")
      .set("Idempotency-Key", `ledger-route-${randomUUID()}`)
      .send({
        fromAccountId: testSenderId,
        toAccountId: testReceiverId,
        amountPaise: "20000",
      });

    expect(transferResponse.status).toBe(201);

    const transferId = transferResponse.body.transfer.id;

    const response = await request(app)
      .get(`/api/transfers/${transferId}/ledger`);

    expect(response.status).toBe(200);
    expect(response.body.transferId).toBe(transferId);
    expect(response.body.count).toBe(2);
    expect(response.body.entries).toHaveLength(2);

    expect(
      response.body.entries.map(
        (entry: { entry_type: string }) => entry.entry_type
      )
    ).toEqual(["DEBIT", "CREDIT"]);
  });
});

 afterAll(async () => {
    await pool.end();
    await adminPool.end();
  });