
import { describe, expect, it } from "vitest";
import { validateWorkloadConfig } from "../../../src/workload/validate-config";
import type { WorkloadConfig } from "../../../src/workload/types";

const validConfig: WorkloadConfig = {
  seed: 12345,
  accountCount: 10,
  transferCount: 100,
  minAmountPaise: "100",
  maxAmountPaise: "100000",
  invalidRequestPercentage: 10,
  concurrency: 5,
};

describe("validateWorkloadConfig", () => {
  it("accepts a valid configuration", () => {
    expect(() => validateWorkloadConfig(validConfig)).not.toThrow();
  });

  it("accepts zero as a seed", () => {
    expect(() =>
      validateWorkloadConfig({ ...validConfig, seed: 0 }),
    ).not.toThrow();
  });

  it("rejects an invalid seed", () => {
    expect(() =>
      validateWorkloadConfig({ ...validConfig, seed: -1 }),
    ).toThrow("Seed must be an unsigned 32-bit integer.");
  });

  it("rejects an account count below two", () => {
    expect(() =>
      validateWorkloadConfig({ ...validConfig, accountCount: 1 }),
    ).toThrow("Account count must be an integer of at least 2.");
  });

  it("rejects a non-integer transfer count", () => {
    expect(() =>
      validateWorkloadConfig({ ...validConfig, transferCount: 2.5 }),
    ).toThrow("Transfer count must be a positive integer.");
  });

  it("rejects zero concurrency", () => {
    expect(() =>
      validateWorkloadConfig({ ...validConfig, concurrency: 0 }),
    ).toThrow("Concurrency must be a positive integer.");
  });

  it("rejects percentages outside the range", () => {
    expect(() =>
      validateWorkloadConfig({
        ...validConfig,
        invalidRequestPercentage: 101,
      }),
    ).toThrow("Invalid request percentage must be between 0 and 100.");
  });

  it("rejects decimal percentages", () => {
    expect(() =>
      validateWorkloadConfig({
        ...validConfig,
        invalidRequestPercentage: 10.5,
      }),
    ).not.toThrow();
  });

  it("rejects zero minimum amount", () => {
    expect(() =>
      validateWorkloadConfig({ ...validConfig, minAmountPaise: "0" }),
    ).toThrow("Minimum amount must be a positive integer string.");
  });

  it("rejects non-integer amount strings", () => {
    expect(() =>
      validateWorkloadConfig({ ...validConfig, maxAmountPaise: "10.5" }),
    ).toThrow("Maximum amount must be a positive integer string.");
  });

  it("rejects amounts exceeding PostgreSQL BIGINT maximum", () => {
    expect(() =>
      validateWorkloadConfig({
        ...validConfig,
        maxAmountPaise: "9223372036854775808",
      }),
    ).toThrow("Transfer amounts must not exceed PostgreSQL BIGINT maximum.");
  });

  it("rejects minimum amount greater than maximum amount", () => {
    expect(() =>
      validateWorkloadConfig({
        ...validConfig,
        minAmountPaise: "2000",
        maxAmountPaise: "1000",
      }),
    ).toThrow("Minimum amount cannot exceed maximum amount.");
  });
});
