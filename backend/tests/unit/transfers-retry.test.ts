import { describe, it, expect, vi } from "vitest";
import { withTransactionRetry } from "../../src/services/transaction-retry";

describe("Transaction retry", () => {
  it("retries a transaction when PostgreSQL detects a deadlock", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce({ code: "40P01" })
      .mockResolvedValueOnce("SUCCESS");

    const result = await withTransactionRetry(operation);

    expect(operation).toHaveBeenCalledTimes(2);
    expect(result).toBe("SUCCESS");
  });

  it("retries a transaction when PostgreSQL detects a serialization failure", async () => {
  const operation = vi.fn()
    .mockRejectedValueOnce({ code: "40001" })
    .mockResolvedValueOnce("SUCCESS");

  const result = await withTransactionRetry(operation);

  expect(operation).toHaveBeenCalledTimes(2);
  expect(result).toBe("SUCCESS");
});

it("does not retry a non-retryable transaction error", async () => {
  const error = new Error("INSUFFICIENT_FUNDS");

  const operation = vi.fn().mockRejectedValue(error);

  await expect(withTransactionRetry(operation)).rejects.toThrow(
    "INSUFFICIENT_FUNDS"
  );

  expect(operation).toHaveBeenCalledTimes(1);
});

it("stops retrying after four total attempts", async () => {
  const operation = vi.fn().mockRejectedValue({ code: "40P01" });

  await expect(withTransactionRetry(operation)).rejects.toEqual({
    code: "40P01",
  });

  expect(operation).toHaveBeenCalledTimes(4);
});

it("does not retry an uncertain COMMIT outcome", async () => {
  const error = new Error("TRANSFER_COMMIT_OUTCOME_UNKNOWN");

  const operation = vi.fn().mockRejectedValue(error);

  await expect(withTransactionRetry(operation)).rejects.toThrow(
    "TRANSFER_COMMIT_OUTCOME_UNKNOWN"
  );

  expect(operation).toHaveBeenCalledTimes(1);
});
});