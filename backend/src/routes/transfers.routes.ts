import { Router } from "express";
import {
  getTransferLedger,
  createTransfer,
} from "../services/transfers.service";

const router = Router();

const DATABASE_UNAVAILABLE_CODES = new Set([
  "57P01",
  "57P02",
  "57P03",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

function isDatabaseUnavailableError(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  ) {
    return false;
  }

  const code = error.code;

  return (
    code.startsWith("08") ||
    DATABASE_UNAVAILABLE_CODES.has(code)
  );
}

router.post("/", async (req, res) => {
  const { fromAccountId, toAccountId, amountPaise } = req.body;
  const idempotencyKey = req.header("Idempotency-Key");

 if (!idempotencyKey) {
  return res.status(400).json({
    error: {
      code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "The Idempotency-Key header is required.",
    },
  });
}

  try {
    const result = await createTransfer({
      fromAccountId,
      toAccountId,
      amountPaise,
      idempotencyKey,
    });

    return res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";

    if (isDatabaseUnavailableError(error)) {
  console.error("Database connection failure:", error);

  return res.status(503).json({
    error: {
      code: "SERVICE_UNAVAILABLE",
      message: "The service is temporarily unavailable. Please try again.",
    },
  });
}

if (code === "TRANSFER_COMMIT_OUTCOME_UNKNOWN") {
  console.error("Transfer COMMIT outcome unknown:", error);

  return res.status(503).json({
    error: {
      code: "TRANSFER_COMMIT_OUTCOME_UNKNOWN",
      message:
        "The transfer outcome could not be confirmed. Retry the request using the same idempotency key.",
    },
  });
}

    const statusCodes: Record<string, number> = {
      INVALID_ACCOUNT_ID: 400,
      SAME_ACCOUNT_TRANSFER: 400,
      INVALID_AMOUNT: 400,
      INVALID_IDEMPOTENCY_KEY: 400,
      ACCOUNT_NOT_FOUND: 404,
      ACCOUNT_NOT_ACTIVE: 409,
      INSUFFICIENT_FUNDS: 409,
      IDEMPOTENCY_KEY_REUSED: 409,
    };

  const status = statusCodes[code] ?? 500;

if (status === 500) {
  console.error("Unexpected transfer error:", error);

  return res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred.",
    },
  });
}

return res.status(status).json({
  error: {
    code,
    message: "The transfer request could not be completed.",
  },
});
  }
});

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/:id/ledger", async (req, res) => {
  const { id } = req.params;

  // 1. Validate transfer ID
  if (!UUID_REGEX.test(id)) {
    return res.status(400).json({
      error: {
        code: "INVALID_TRANSFER_ID",
        message: "The transfer ID must be a valid UUID.",
      },
    });
  }

  try {
    // 2. Retrieve ledger entries
    const entries = await getTransferLedger(id);

    // 3. Handle missing transfer
    if (entries === null) {
      return res.status(404).json({
        error: {
          code: "TRANSFER_NOT_FOUND",
          message: "The requested transfer could not be found.",
        },
      });
    }

    // 4. Successful response
    return res.status(200).json({
      transferId: id,
      count: entries.length,
      entries,
    });
  } catch (error) {
    // 5. Handle database connection failures
    if (isDatabaseUnavailableError(error)) {
      console.error("Database connection failure during ledger retrieval:", error);

      return res.status(503).json({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "The service is temporarily unavailable. Please try again.",
        },
      });
    }

    // 6. Handle unexpected errors
    console.error("Unexpected ledger retrieval error:", error);

    return res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
      },
    });
  }
});

export default router;