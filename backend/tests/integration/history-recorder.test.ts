
import {
  describe,
  it,
  expect,
  afterAll,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import app from "../../src/app";
import { pool } from "../../src/db/pool";
import { adminPool } from "../helpers/admin-pool";
import { executeAndRecordWorkload } from "../../src/history/recorder";
import { readHistoryFile } from "../../src/history/parser";
import { buildHistoryIndexes } from "../../src/history/indexes";
import {
  summarizeOutcomes,
  calculateLatencyPercentiles,
  findSlowestRequests,
} from "../../src/history/analysis";
import { generateWorkload } from "../../src/workload/generator";
import { exportWorkload } from "../../src/workload/report";
import type {
  GeneratedWorkload,
  WorkloadConfig,
} from "../../src/workload/types";

describe("History Recorder integration", () => {
  afterAll(async () => {
    await pool.end();
    await adminPool.end();
  });

  it("executes, records, persists and recovers every Safe Mode request", async () => {
    const userId = randomUUID();
    const senderId = randomUUID();
    const receiverId = randomUUID();

    const directory = await mkdtemp(
      join(tmpdir(), "ledgerlab-history-"),
    );
    const historyPath = join(directory, "history.jsonl");

    try {
      await adminPool.query(
        `INSERT INTO users (id, name, email, password_hash)
         VALUES ($1, 'History Test', $2, 'test-hash')`,
        [userId, `history-${userId}@ledgerlab.local`],
      );

      await adminPool.query(
        `INSERT INTO accounts (id, user_id, balance_paise)
         VALUES ($1, $3, 50000), ($2, $3, 10000)`,
        [senderId, receiverId, userId],
      );

      await adminPool.query(
        `INSERT INTO account_opening_balances
         (account_id, amount_paise)
         VALUES ($1, 50000), ($2, 10000)`,
        [senderId, receiverId],
      );

      const workload: GeneratedWorkload = {
        config: {
          seed: 12345,
          accountCount: 2,
          transferCount: 2,
          minAmountPaise: "100",
          maxAmountPaise: "20000",
          invalidRequestPercentage: 50,
          concurrency: 1,
        },
        transfers: [
          {
            requestId: "history-request-001",
            correlationId: "history-correlation-001",
            fromAccountId: senderId,
            toAccountId: receiverId,
            amountPaise: "5000",
            idempotencyKey: "history-key-001",
            expectedValidity: "VALID",
          },
          {
            requestId: "history-request-002",
            correlationId: "history-correlation-002",
            fromAccountId: senderId,
            toAccountId: receiverId,
            amountPaise: "0",
            idempotencyKey: "history-key-002",
            expectedValidity: "INVALID",
            invalidReason: "ZERO_AMOUNT",
          },
        ],
      };

      const server = app.listen(0);

      try {
        const address = server.address();

        if (!address || typeof address === "string") {
          throw new Error("Could not determine test server port.");
        }

        const records = await executeAndRecordWorkload(
          workload,
          "SAFE",
          `http://127.0.0.1:${address.port}`,
          historyPath,
        );

        expect(records).toHaveLength(2);

        expect(records.map((record) => record.requestId)).toEqual([
          "history-request-001",
          "history-request-002",
        ]);

        expect(records[0].outcome).toBe("SUCCESS");
        expect(records[0].transferOutcome).toBe(
          "CONFIRMED_COMMITTED",
        );
        expect(records[0].httpStatus).toBe(201);
        expect(records[0].transferId).toBeTruthy();

        expect(records[1].outcome).toBe("FAILURE");
        expect(records[1].transferOutcome).toBe(
          "CONFIRMED_NOT_COMMITTED",
        );
        expect(records[1].httpStatus).toBe(400);
        expect(records[1].error?.code).toBe("INVALID_AMOUNT");

        const parsed = await readHistoryFile(historyPath);

        expect(parsed.errors).toHaveLength(0);
        expect(parsed.records).toHaveLength(2);

        const requestIds = parsed.records.map(
          (record) => record.requestId,
        );

        expect(new Set(requestIds).size).toBe(2);

        const indexes = buildHistoryIndexes(parsed.records);

        expect(
          indexes.byCorrelationId.get("history-correlation-001"),
        ).toHaveLength(1);

        expect(
          indexes.byCorrelationId.get("history-correlation-002"),
        ).toHaveLength(1);

        expect(
          indexes.byTransferId.has(records[0].transferId!),
        ).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("executes the 100-request seeded sample and saves its complete history", async () => {
    const config: WorkloadConfig = {
      seed: 12345,
      accountCount: 10,
      transferCount: 100,
      minAmountPaise: "100",
      maxAmountPaise: "100000",
      invalidRequestPercentage: 10,
      concurrency: 5,
    };

    const userId = randomUUID();

    // Fresh fixture IDs prevent collisions with previous sample runs.
    const accountIds = Array.from(
      { length: config.accountCount },
      () => randomUUID(),
    );

    const workload = generateWorkload(config, accountIds);

    const workloadsDirectory = resolve(
      process.cwd(),
      "workloads",
    );

    await mkdir(workloadsDirectory, { recursive: true });

    const workloadPath = join(
      workloadsDirectory,
      "naive-comparison-workload-12345.json",
    );

    const historyPath = join(
      workloadsDirectory,
      "naive-comparison-history-12345.jsonl",
    );

    // Save the exact workload used for this execution.
    await exportWorkload(workload, workloadPath);

    // Start with a fresh history file rather than appending old records.
    await writeFile(historyPath, "", "utf8");

    await adminPool.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, 'History Sample', $2, 'sample-test-hash')`,
      [userId, `history-sample-${userId}@ledgerlab.local`],
    );

    // Give every account a large opening balance so that valid
    // transfers do not fail because of insufficient funds.
    await adminPool.query(
      `INSERT INTO accounts (id, user_id, balance_paise)
       SELECT account_id, $2, 1000000000000
       FROM unnest($1::uuid[]) AS ids(account_id)`,
      [accountIds, userId],
    );

    await adminPool.query(
      `INSERT INTO account_opening_balances
       (account_id, amount_paise)
       SELECT account_id, 1000000000000
       FROM unnest($1::uuid[]) AS ids(account_id)`,
      [accountIds],
    );

    const server = app.listen(0);

    try {
      const address = server.address();

      if (!address || typeof address === "string") {
        throw new Error("Could not determine sample server port.");
      }

      console.log("\nStarting 100-request Naive Mode comparison...");

      const records = await executeAndRecordWorkload(
        workload,
        "NAIVE",
        `http://127.0.0.1:${address.port}`,
        historyPath,
      );

      // Recover the history from the actual JSONL file.
      const parsed = await readHistoryFile(historyPath);

      expect(parsed.errors).toHaveLength(0);
      expect(records).toHaveLength(config.transferCount);
      expect(parsed.records).toHaveLength(config.transferCount);

      const generatedRequestIds = workload.transfers.map(
        (transfer) => transfer.requestId,
      );

      const recordedRequestIds = parsed.records.map(
        (record) => record.requestId,
      );

      // Every generated request must appear exactly once.
      expect(new Set(recordedRequestIds).size).toBe(
        config.transferCount,
      );

      expect([...recordedRequestIds].sort()).toEqual(
        [...generatedRequestIds].sort(),
      );

      const validCount = workload.transfers.filter(
        (transfer) => transfer.expectedValidity === "VALID",
      ).length;

      const invalidCount =
        config.transferCount - validCount;

      expect(validCount).toBe(90);
      expect(invalidCount).toBe(10);

      const indexes = buildHistoryIndexes(parsed.records);
      const summary = summarizeOutcomes(parsed.records);
      const latency = calculateLatencyPercentiles(parsed.records);
      const slowest = findSlowestRequests(parsed.records, 5);

      expect(indexes.byRequestId.size).toBe(100);
      expect(indexes.byCorrelationId.size).toBe(100);

      console.log("\n========== SAMPLE WORKLOAD REPORT ==========");
      console.log(`Seed: ${config.seed}`);
      console.log(`Total requests: ${summary.totalRecords}`);
      console.log(`Valid generated requests: ${validCount}`);
      console.log(`Invalid generated requests: ${invalidCount}`);
      console.log(`Concurrency: ${config.concurrency}`);

      console.log("\nRequest outcomes:");
      console.log(summary.requestOutcomes);

      console.log("\nTransfer outcomes:");
      console.log(summary.transferOutcomes);

      console.log("\nLatency (ms):");
      console.log({
        samples: latency.sampleCount,
        p50: latency.p50,
        p95: latency.p95,
        p99: latency.p99,
      });

      console.log("\nTop 5 slowest requests:");
      console.log(
        slowest.map((record) => ({
          requestId: record.requestId,
          durationMs: record.durationMs,
          httpStatus: record.httpStatus,
          outcome: record.outcome,
        })),
      );

      console.log("\nSaved workload:", workloadPath);
      console.log("Saved history:", historyPath);
      console.log("============================================\n");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});
