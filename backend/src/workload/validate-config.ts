
import type { WorkloadConfig } from "./types";

const MAX_SEED = 0xffffffff;
const MAX_BIGINT = 9223372036854775807n;

export function validateWorkloadConfig(config: WorkloadConfig): void {
  if (
    !Number.isInteger(config.seed) ||
    config.seed < 0 ||
    config.seed > MAX_SEED
  ) {
    throw new Error("Seed must be an unsigned 32-bit integer.");
  }

  if (!Number.isInteger(config.accountCount) || config.accountCount < 2) {
    throw new Error("Account count must be an integer of at least 2.");
  }

  if (!Number.isInteger(config.transferCount) || config.transferCount < 1) {
    throw new Error("Transfer count must be a positive integer.");
  }

  if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
    throw new Error("Concurrency must be a positive integer.");
  }

  if (
    !Number.isFinite(config.invalidRequestPercentage) ||
    config.invalidRequestPercentage < 0 ||
    config.invalidRequestPercentage > 100
  ) {
    throw new Error("Invalid request percentage must be between 0 and 100.");
  }

  if (!/^[1-9]\d*$/.test(config.minAmountPaise)) {
    throw new Error("Minimum amount must be a positive integer string.");
  }

  if (!/^[1-9]\d*$/.test(config.maxAmountPaise)) {
    throw new Error("Maximum amount must be a positive integer string.");
  }

  const minAmount = BigInt(config.minAmountPaise);
  const maxAmount = BigInt(config.maxAmountPaise);

  if (minAmount > MAX_BIGINT || maxAmount > MAX_BIGINT) {
    throw new Error("Transfer amounts must not exceed PostgreSQL BIGINT maximum.");
  }

  if (minAmount > maxAmount) {
    throw new Error("Minimum amount cannot exceed maximum amount.");
  }
}
