
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  serializeWorkload,
  exportWorkload,
} from "../../../src/workload/report";

import type { GeneratedWorkload } from "../../../src/workload/types";

function createSampleWorkload(): GeneratedWorkload {
  return {
    config: {
      seed: 12345,
      accountCount: 3,
      transferCount: 2,
      minAmountPaise: "100",
      maxAmountPaise: "100000",
      invalidRequestPercentage: 50,
      concurrency: 2,
    },
    transfers: [
      {
        requestId: "workload-12345-0",
        correlationId: "ledgerlab-12345-0",
        fromAccountId: "account-1",
        toAccountId: "account-2",
        amountPaise: "5000",
        idempotencyKey: "ledgerlab:12345:0",
        expectedValidity: "VALID",
      },
      {
        requestId: "workload-12345-1",
        correlationId: "ledgerlab-12345-1",
        fromAccountId: "account-3",
        toAccountId: "account-3",
        amountPaise: "0",
        idempotencyKey: "ledgerlab:12345:1",
        expectedValidity: "INVALID",
        invalidReason: "SAME_ACCOUNT",
      },
    ],
  };
}

describe("serializeWorkload", () => {
  it("preserves the complete workload configuration", () => {
    const workload = createSampleWorkload();

    const result = JSON.parse(serializeWorkload(workload));

    expect(result.config).toEqual(workload.config);
  });

  it("preserves all generated transfers", () => {
    const workload = createSampleWorkload();

    const result = JSON.parse(serializeWorkload(workload));

    expect(result.transfers).toEqual(workload.transfers);
    expect(result.transfers).toHaveLength(2);
  });

  it("preserves invalid reasons", () => {
    const workload = createSampleWorkload();

    const result = JSON.parse(serializeWorkload(workload));

    expect(result.transfers[1].expectedValidity).toBe("INVALID");
    expect(result.transfers[1].invalidReason).toBe("SAME_ACCOUNT");
  });

  it("preserves large monetary amounts as strings", () => {
    const workload = createSampleWorkload();

    workload.transfers[0].amountPaise = "900719925474099312345";

    const result = JSON.parse(serializeWorkload(workload));

    expect(result.transfers[0].amountPaise).toBe(
      "900719925474099312345",
    );
    expect(typeof result.transfers[0].amountPaise).toBe("string");
  });

  it("does not modify the original workload", () => {
    const workload = createSampleWorkload();
    const original = structuredClone(workload);

    serializeWorkload(workload);

    expect(workload).toEqual(original);
  });
});

describe("exportWorkload", () => {
  it("writes a valid JSON workload to the requested file", async () => {
    const workload = createSampleWorkload();
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "ledgerlab-workload-"),
    );

    try {
      const outputPath = path.join(
        temporaryDirectory,
        "workload.json",
      );

      await exportWorkload(workload, outputPath);

      const fileContents = await readFile(outputPath, "utf8");
      const result = JSON.parse(fileContents);

      expect(result).toEqual(workload);
    } finally {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("exports invalid request information", async () => {
    const workload = createSampleWorkload();
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "ledgerlab-workload-"),
    );

    try {
      const outputPath = path.join(
        temporaryDirectory,
        "workload.json",
      );

      await exportWorkload(workload, outputPath);

      const fileContents = await readFile(outputPath, "utf8");
      const result = JSON.parse(fileContents);

      expect(result.transfers[1].invalidReason).toBe("SAME_ACCOUNT");
    } finally {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  });
});
