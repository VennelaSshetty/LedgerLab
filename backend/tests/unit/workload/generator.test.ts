
import { describe, expect, it } from "vitest";
import { generateWorkload } from "../../../src/workload/generator";
import type {
  InvalidReason,
  WorkloadConfig,
} from "../../../src/workload/types";

const accountIds = [
  "account-1",
  "account-2",
  "account-3",
  "account-4",
  "account-5",
];

const validConfig: WorkloadConfig = {
  seed: 12345,
  accountCount: 5,
  transferCount: 100,
  minAmountPaise: "100",
  maxAmountPaise: "100000",
  invalidRequestPercentage: 10,
  concurrency: 5,
};

const uuidAccountIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];

const invalidReasons: InvalidReason[] = [
  "SAME_ACCOUNT",
  "MALFORMED_ACCOUNT_ID",
  "NONEXISTENT_ACCOUNT",
  "ZERO_AMOUNT",
  "NEGATIVE_AMOUNT",
];

describe("generateWorkload", () => {
  it("generates identical workloads for the same seed and configuration", () => {
    const first = generateWorkload(validConfig, accountIds);
    const second = generateWorkload(validConfig, accountIds);

    expect(first).toEqual(second);
  });

  it("generates different workloads for different seeds", () => {
    const first = generateWorkload(validConfig, accountIds);

    const second = generateWorkload(
      { ...validConfig, seed: 54321 },
      accountIds,
    );

    expect(first.transfers).not.toEqual(second.transfers);
  });

  it("generates the configured number of transfers", () => {
    const workload = generateWorkload(validConfig, accountIds);

    expect(workload.transfers).toHaveLength(
      validConfig.transferCount,
    );
  });

  it("keeps every valid transfer amount within the configured inclusive range", () => {
    const workload = generateWorkload(validConfig, accountIds);

    const validTransfers = workload.transfers.filter(
      (transfer) => transfer.expectedValidity === "VALID",
    );

    for (const transfer of validTransfers) {
      const amount = BigInt(transfer.amountPaise);

      expect(amount).toBeGreaterThanOrEqual(
        BigInt(validConfig.minAmountPaise),
      );

      expect(amount).toBeLessThanOrEqual(
        BigInt(validConfig.maxAmountPaise),
      );
    }
  });

  it("never generates the same sender and receiver for valid transfers", () => {
    const workload = generateWorkload(validConfig, accountIds);

    const validTransfers = workload.transfers.filter(
      (transfer) => transfer.expectedValidity === "VALID",
    );

    for (const transfer of validTransfers) {
      expect(transfer.fromAccountId).not.toBe(
        transfer.toAccountId,
      );
    }
  });

it("generates deterministic request and correlation IDs", () => {
  const workload = generateWorkload(validConfig, accountIds);

  workload.transfers.forEach((transfer, index) => {
    expect(transfer.requestId).toBe(
      `workload-${validConfig.seed}-${index}`,
    );

    expect(transfer.correlationId).toBe(
      `ledgerlab-${validConfig.seed}-${index}`,
    );
  });
});

  it("generates unique idempotency keys across valid and invalid transfers", () => {
    const workload = generateWorkload(validConfig, accountIds);

    const keys = workload.transfers.map(
      (transfer) => transfer.idempotencyKey,
    );

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("generates only valid transfers when invalid percentage is zero", () => {
    const config = {
      ...validConfig,
      invalidRequestPercentage: 0,
    };

    const workload = generateWorkload(config, accountIds);

    for (const transfer of workload.transfers) {
      expect(transfer.expectedValidity).toBe("VALID");
      expect(transfer.invalidReason).toBeUndefined();
    }
  });

  it("generates the exact configured number of invalid transfers", () => {
    const workload = generateWorkload(validConfig, accountIds);

    const invalidTransfers = workload.transfers.filter(
      (transfer) => transfer.expectedValidity === "INVALID",
    );

    const expectedInvalidCount = Math.floor(
      (validConfig.transferCount *
        validConfig.invalidRequestPercentage) /
        100,
    );

    expect(invalidTransfers).toHaveLength(expectedInvalidCount);
  });

  it("supports amounts larger than Number.MAX_SAFE_INTEGER for valid transfers", () => {
    const largeAmountConfig: WorkloadConfig = {
      ...validConfig,
      minAmountPaise: "9007199254740993",
      maxAmountPaise: "9223372036854775807",
    };

    const workload = generateWorkload(
      largeAmountConfig,
      accountIds,
    );

    const validTransfers = workload.transfers.filter(
      (transfer) => transfer.expectedValidity === "VALID",
    );

    for (const transfer of validTransfers) {
      const amount = BigInt(transfer.amountPaise);

      expect(amount).toBeGreaterThanOrEqual(
        BigInt(largeAmountConfig.minAmountPaise),
      );

      expect(amount).toBeLessThanOrEqual(
        BigInt(largeAmountConfig.maxAmountPaise),
      );
    }
  });

  it("rejects an account ID count that does not match the configuration", () => {
    expect(() =>
      generateWorkload(validConfig, accountIds.slice(0, 3)),
    ).toThrow(
      "Account ID count must match configured account count.",
    );
  });

  it("rejects duplicate account IDs", () => {
    const duplicateAccountIds = [
      "account-1",
      "account-2",
      "account-3",
      "account-4",
      "account-1",
    ];

    expect(() =>
      generateWorkload(validConfig, duplicateAccountIds),
    ).toThrow("Account IDs must be unique.");
  });

  it("rejects empty account IDs", () => {
    const invalidAccountIds = [
      "account-1",
      "account-2",
      "",
      "account-4",
      "account-5",
    ];

    expect(() =>
      generateWorkload(validConfig, invalidAccountIds),
    ).toThrow("Account IDs must be non-empty strings.");
  });

  it("generates all five invalid request categories", () => {
    const config: WorkloadConfig = {
      ...validConfig,
      transferCount: 50,
      invalidRequestPercentage: 100,
    };

    const workload = generateWorkload(config, uuidAccountIds);

    const generatedReasons = new Set(
      workload.transfers.map((transfer) => transfer.invalidReason),
    );

    for (const reason of invalidReasons) {
      expect(generatedReasons.has(reason)).toBe(true);
    }
  });

  it("generates same-account requests with identical account IDs", () => {
    const config = {
      ...validConfig,
      invalidRequestPercentage: 100,
    };

    const workload = generateWorkload(config, uuidAccountIds);

    const transfers = workload.transfers.filter(
      (transfer) => transfer.invalidReason === "SAME_ACCOUNT",
    );

    expect(transfers.length).toBeGreaterThan(0);

    for (const transfer of transfers) {
      expect(transfer.fromAccountId).toBe(
        transfer.toAccountId,
      );
      expect(transfer.expectedValidity).toBe("INVALID");
    }
  });

  it("generates malformed account IDs for malformed-ID requests", () => {
    const config = {
      ...validConfig,
      invalidRequestPercentage: 100,
    };

    const workload = generateWorkload(config, uuidAccountIds);

    const transfers = workload.transfers.filter(
      (transfer) =>
        transfer.invalidReason === "MALFORMED_ACCOUNT_ID",
    );

    expect(transfers.length).toBeGreaterThan(0);

    for (const transfer of transfers) {
      expect(transfer.fromAccountId).toBe("not-a-valid-uuid");
      expect(uuidAccountIds).toContain(transfer.toAccountId);
    }
  });

  it("generates UUID-shaped nonexistent-account candidates", () => {
    const config = {
      ...validConfig,
      invalidRequestPercentage: 100,
    };

    const workload = generateWorkload(config, uuidAccountIds);

    const transfers = workload.transfers.filter(
      (transfer) =>
        transfer.invalidReason === "NONEXISTENT_ACCOUNT",
    );

    expect(transfers.length).toBeGreaterThan(0);

    for (const transfer of transfers) {
      expect(transfer.fromAccountId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      expect(uuidAccountIds).not.toContain(
        transfer.fromAccountId,
      );
    }
  });

  it("generates zero-amount requests", () => {
    const config = {
      ...validConfig,
      invalidRequestPercentage: 100,
    };

    const workload = generateWorkload(config, uuidAccountIds);

    const transfers = workload.transfers.filter(
      (transfer) => transfer.invalidReason === "ZERO_AMOUNT",
    );

    expect(transfers.length).toBeGreaterThan(0);

    for (const transfer of transfers) {
      expect(transfer.amountPaise).toBe("0");
    }
  });

  it("generates negative-amount requests", () => {
    const config = {
      ...validConfig,
      invalidRequestPercentage: 100,
    };

    const workload = generateWorkload(config, uuidAccountIds);

    const transfers = workload.transfers.filter(
      (transfer) => transfer.invalidReason === "NEGATIVE_AMOUNT",
    );

    expect(transfers.length).toBeGreaterThan(0);

    for (const transfer of transfers) {
      expect(transfer.amountPaise).toBe("-100");
    }
  });

  it("preserves the total transfer count when every request is invalid", () => {
    const config = {
      ...validConfig,
      invalidRequestPercentage: 100,
    };

    const workload = generateWorkload(config, uuidAccountIds);

    expect(workload.transfers).toHaveLength(config.transferCount);

    expect(
      workload.transfers.every(
        (transfer) => transfer.expectedValidity === "INVALID",
      ),
    ).toBe(true);
  });

  it("distributes invalid requests deterministically", () => {
    const first = generateWorkload(validConfig, uuidAccountIds);
    const second = generateWorkload(validConfig, uuidAccountIds);

    expect(first.transfers).toEqual(second.transfers);

    const invalidIndexes = first.transfers
      .map((transfer, index) =>
        transfer.expectedValidity === "INVALID" ? index : -1,
      )
      .filter((index) => index !== -1);

    expect(invalidIndexes.length).toBe(
      Math.floor(
        (validConfig.transferCount *
          validConfig.invalidRequestPercentage) /
          100,
      ),
    );
  });

  it("generates identical ordered transfers regardless of concurrency", () => {
  const concurrencyOne = generateWorkload(
    { ...validConfig, concurrency: 1 },
    accountIds,
  );

  const concurrencyFive = generateWorkload(
    { ...validConfig, concurrency: 5 },
    accountIds,
  );

  const concurrencyTen = generateWorkload(
    { ...validConfig, concurrency: 10 },
    accountIds,
  );

  expect(concurrencyOne.transfers).toEqual(
    concurrencyFive.transfers,
  );

  expect(concurrencyFive.transfers).toEqual(
    concurrencyTen.transfers,
  );
});
});
