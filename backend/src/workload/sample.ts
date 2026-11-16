
import path from "node:path";

import { generateWorkload } from "./generator";
import { exportWorkload } from "./report";
import type { WorkloadConfig } from "./types";

const config: WorkloadConfig = {
  seed: 12345,
  accountCount: 10,
  transferCount: 100,
  minAmountPaise: "100",
  maxAmountPaise: "100000",
  invalidRequestPercentage: 10,
  concurrency: 5,
};

function createSampleAccountIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const suffix = (index + 1).toString(16).padStart(12, "0");

    return `00000000-0000-4000-8000-${suffix}`;
  });
}

async function main(): Promise<void> {
  const accountIds = createSampleAccountIds(config.accountCount);

  const workload = generateWorkload(config, accountIds);

  const outputDirectory = path.resolve(process.cwd(), "workloads");

  const outputPath = path.join(
    outputDirectory,
    `workload-${config.seed}.json`,
  );

  await exportWorkload(workload, outputPath);

  const validCount = workload.transfers.filter(
    (transfer) => transfer.expectedValidity === "VALID",
  ).length;

  const invalidCount = workload.transfers.length - validCount;

  console.log("========================================");
  console.log("       LEDGERLAB SAMPLE WORKLOAD");
  console.log("========================================");
  console.log(`Seed:               ${config.seed}`);
  console.log(`Accounts:           ${config.accountCount}`);
  console.log(`Transfers:          ${config.transferCount}`);
  console.log(`Valid requests:     ${validCount}`);
  console.log(`Invalid requests:   ${invalidCount}`);
  console.log(`Concurrency:        ${config.concurrency}`);
  console.log(`Output file:        ${outputPath}`);
  console.log("========================================");
}

main().catch((error: unknown) => {
  console.error("Failed to generate sample workload:", error);
  process.exitCode = 1;
});
