import { createPrng } from "./prng";
import { validateWorkloadConfig } from "./validate-config";

import type {
  GeneratedWorkload,
  InvalidReason,
  WorkloadConfig,
  WorkloadTransfer,
} from "./types";

/**
 * Generates an unbiased random BigInt in the range [0, upperBound).
 *
 * Uses rejection sampling to avoid modulo bias.
 * Does not convert monetary values to JavaScript Number.
 */
function generateRandomBigIntBelow(
  random: () => number,
  upperBound: bigint,
): bigint {
  if (upperBound <= 0n) {
    throw new Error("Upper bound must be positive.");
  }

  if (upperBound === 1n) {
    return 0n;
  }

  const bitLength = (upperBound - 1n).toString(2).length;
  const chunkCount = Math.ceil(bitLength / 32);

  const totalBits = BigInt(chunkCount * 32);
  const randomSpace = 1n << totalBits;

  const acceptanceLimit =
    randomSpace - (randomSpace % upperBound);

  while (true) {
    let candidate = 0n;

    for (let i = 0; i < chunkCount; i++) {
      const randomChunk = BigInt(
        Math.floor(random() * 4294967296),
      );

      candidate = (candidate << 32n) | randomChunk;
    }

    if (candidate < acceptanceLimit) {
      return candidate % upperBound;
    }
  }
}

/**
 * Generates a random transfer amount in the inclusive range
 * [minAmount, maxAmount].
 */
function generateAmount(
  random: () => number,
  minAmount: bigint,
  maxAmount: bigint,
): string {
  const range = maxAmount - minAmount + 1n;
  const offset = generateRandomBigIntBelow(random, range);

  return (minAmount + offset).toString();
}

/**
 * Selects a deterministic account index using the seeded PRNG.
 */
function selectAccountIndex(
  random: () => number,
  accountCount: number,
): number {
  return Math.floor(random() * accountCount);
}

/**
 * Returns the exact number of invalid requests requested by the config.
 */
function calculateInvalidCount(config: WorkloadConfig): number {
  return Math.floor(
    (config.transferCount * config.invalidRequestPercentage) / 100,
  );
}

/**
 * Distributes invalid requests across the workload.
 *
 * Produces exactly invalidCount invalid positions.
 */
function isInvalidPosition(
  index: number,
  transferCount: number,
  invalidCount: number,
): boolean {
  return (
    Math.floor(((index + 1) * invalidCount) / transferCount) >
    Math.floor((index * invalidCount) / transferCount)
  );
}

/**
 * Creates a deterministic UUID-shaped candidate that is not among
 * the supplied fixture account IDs.
 *
 * The database fixture setup must separately verify that this ID
 * does not already exist in the database.
 */
function generateNonexistentAccountCandidate(
  index: number,
  accountIds: string[],
): string {
  const existingIds = new Set(accountIds);

  let suffix = BigInt(index + 1);

  while (true) {
    const hex = suffix.toString(16).padStart(12, "0");

    const candidate = `00000000-0000-4000-8000-${hex}`;

    if (!existingIds.has(candidate)) {
      return candidate;
    }

    suffix++;
  }
}

const INVALID_REASONS: InvalidReason[] = [
  "SAME_ACCOUNT",
  "MALFORMED_ACCOUNT_ID",
  "NONEXISTENT_ACCOUNT",
  "ZERO_AMOUNT",
  "NEGATIVE_AMOUNT",
];

/**
 * Converts a structurally valid transfer into one deliberately
 * invalid request.
 *
 * Each case changes only the field(s) needed to trigger its
 * intended validation failure.
 */
function makeInvalidTransfer(
  transfer: WorkloadTransfer,
  reason: InvalidReason,
  accountIds: string[],
  index: number,
): WorkloadTransfer {
  switch (reason) {
    case "SAME_ACCOUNT":
      return {
        ...transfer,
        toAccountId: transfer.fromAccountId,
        expectedValidity: "INVALID",
        invalidReason: reason,
      };

    case "MALFORMED_ACCOUNT_ID":
      return {
        ...transfer,
        fromAccountId: "not-a-valid-uuid",
        expectedValidity: "INVALID",
        invalidReason: reason,
      };

    case "NONEXISTENT_ACCOUNT":
      return {
        ...transfer,
        fromAccountId: generateNonexistentAccountCandidate(
          index,
          accountIds,
        ),
        expectedValidity: "INVALID",
        invalidReason: reason,
      };

    case "ZERO_AMOUNT":
      return {
        ...transfer,
        amountPaise: "0",
        expectedValidity: "INVALID",
        invalidReason: reason,
      };

    case "NEGATIVE_AMOUNT":
      return {
        ...transfer,
        amountPaise: "-100",
        expectedValidity: "INVALID",
        invalidReason: reason,
      };
  }
}

/**
 * Generates a deterministic workload.
 *
 * The same seed, config, and ordered account IDs produce the same
 * ordered workload.
 *
 * This function:
 * - Does not access the database.
 * - Does not generate random UUIDs.
 * - Does not use Math.random().
 * - Does not depend on execution concurrency.
 */
export function generateWorkload(
  config: WorkloadConfig,
  accountIds: string[],
): GeneratedWorkload {
  validateWorkloadConfig(config);

  if (accountIds.length !== config.accountCount) {
    throw new Error(
      "Account ID count must match configured account count.",
    );
  }

  if (
    accountIds.some(
      (id) => typeof id !== "string" || id.length === 0,
    )
  ) {
    throw new Error("Account IDs must be non-empty strings.");
  }

  if (new Set(accountIds).size !== accountIds.length) {
    throw new Error("Account IDs must be unique.");
  }

  const random = createPrng(config.seed);

  const minAmount = BigInt(config.minAmountPaise);
  const maxAmount = BigInt(config.maxAmountPaise);

  const invalidCount = calculateInvalidCount(config);

  const transfers: WorkloadTransfer[] = [];

  let invalidOrdinal = 0;

  for (let index = 0; index < config.transferCount; index++) {
    const senderIndex = selectAccountIndex(
      random,
      accountIds.length,
    );

    let receiverIndex = selectAccountIndex(
      random,
      accountIds.length,
    );

    // Base transfers always begin with distinct accounts.
    while (receiverIndex === senderIndex) {
      receiverIndex = selectAccountIndex(
        random,
        accountIds.length,
      );
    }

    const amountPaise = generateAmount(
      random,
      minAmount,
      maxAmount,
    );

   const validTransfer: WorkloadTransfer = {
  requestId: `workload-${config.seed}-${index}`,
  correlationId: `ledgerlab-${config.seed}-${index}`,
  fromAccountId: accountIds[senderIndex],
  toAccountId: accountIds[receiverIndex],
  amountPaise,
  idempotencyKey: `ledgerlab:${config.seed}:${index}`,
  expectedValidity: "VALID",
};

    if (
      !isInvalidPosition(
        index,
        config.transferCount,
        invalidCount,
      )
    ) {
      transfers.push(validTransfer);
      continue;
    }

    const reason =
      INVALID_REASONS[invalidOrdinal % INVALID_REASONS.length];

    const invalidTransfer = makeInvalidTransfer(
      validTransfer,
      reason,
      accountIds,
      index,
    );

    transfers.push(invalidTransfer);
    invalidOrdinal++;
  }

  return {
    config: { ...config },
    transfers,
  };
}