
import { runWorkloadOverHttp } from "../../src/history/runner";
import type {
  GeneratedWorkload,
  WorkloadTransfer,
} from "../../src/workload/types";
import type { HttpWorkloadExecutionResult } from "../../src/history/runner";

const MAX_BIGINT_PAISE = "9223372036854775807";

export async function executeStressTransfers(
  transfers: WorkloadTransfer[],
  baseUrl: string,
  concurrency: number,
  timeoutMs = 30_000,
): Promise<HttpWorkloadExecutionResult[]> {
  if (transfers.length === 0) {
    throw new Error("At least one transfer is required.");
  }

  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error("Concurrency must be a positive integer.");
  }

  const accountIds = new Set<string>();

  let validCount = 0;
  let minAmount = BigInt(MAX_BIGINT_PAISE);
  let maxAmount = 0n;

  for (const transfer of transfers) {
    accountIds.add(transfer.fromAccountId);
    accountIds.add(transfer.toAccountId);

    if (transfer.expectedValidity === "VALID") {
      validCount++;
    }

    const amount = BigInt(transfer.amountPaise);

    if (amount < minAmount) minAmount = amount;
    if (amount > maxAmount) maxAmount = amount;
  }

  if (accountIds.size < 2) {
    throw new Error("Transfers must reference at least two accounts.");
  }

  const workload: GeneratedWorkload = {
    config: {
      seed: 1,
      accountCount: accountIds.size,
      transferCount: transfers.length,
      minAmountPaise: minAmount.toString(),
      maxAmountPaise: maxAmount.toString(),
      invalidRequestPercentage:
        ((transfers.length - validCount) / transfers.length) * 100,
      concurrency,
    },
    transfers,
  };

  return runWorkloadOverHttp(
    workload,
    "SAFE",
    baseUrl,
    timeoutMs,
  );
}
