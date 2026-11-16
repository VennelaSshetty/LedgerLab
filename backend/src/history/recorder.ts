
import type { GeneratedWorkload } from "../workload/types";
import { runWorkloadOverHttp } from "./runner";
import { createHistoryWriter } from "./writer";
import type {
  ExecutionMode,
  HistoryRecord,
} from "./types";

export async function executeAndRecordWorkload(
  workload: GeneratedWorkload,
  mode: ExecutionMode,
  baseUrl: string,
  filePath: string,
  timeoutMs: number = 10_000,
): Promise<HistoryRecord[]> {
  const results = await runWorkloadOverHttp(
    workload,
    mode,
    baseUrl,
    timeoutMs,
  );

  const writer = await createHistoryWriter(filePath);
  const records: HistoryRecord[] = [];

  try {
    for (const result of results) {
      const record: HistoryRecord = {
        recordVersion: 1,
        requestId: result.transfer.requestId,
        correlationId: result.transfer.correlationId,
        idempotencyKey:
          mode === "SAFE"
            ? result.transfer.idempotencyKey
            : null,
        mode,
        fromAccountId: result.transfer.fromAccountId,
        toAccountId: result.transfer.toAccountId,
        amountPaise: result.transfer.amountPaise,
        expectedValidity: result.transfer.expectedValidity,
        invalidReason: result.transfer.invalidReason ?? null,
        requestStartedAt: result.requestStartedAt,
        responseReceivedAt: result.responseReceivedAt,
        durationMs: result.durationMs,
        httpStatus: result.result?.httpStatus ?? null,
        outcome: result.outcome,
        transferOutcome: result.transferOutcome,
        transferId: result.result?.transferId ?? null,
        timeoutMs,
        error: result.historyError,
      };

      await writer.write(record);
      records.push(record);
    }
  } finally {
    await writer.close();
  }

  return records;
}
