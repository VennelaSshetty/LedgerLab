
import { describe, it, expect, afterAll } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import app from "../../src/app";
import { pool } from "../../src/db/pool";
import { adminPool } from "../helpers/admin-pool";
import { executeAndRecordWorkload } from "../../src/history/recorder";
import { readHistoryFile } from "../../src/history/parser";
import { buildHistoryIndexes } from "../../src/history/indexes";
import {
  summarizeOutcomes,
  calculateLatencyPercentiles,
} from "../../src/history/analysis";
import type { GeneratedWorkload } from "../../src/workload/types";

describe("Naive vs Safe comparison - Naive Mode", () => {
  afterAll(async () => {
   
  });

  it("executes the exact saved 100-request workload against Naive Mode", async () => {
    const workloadsDirectory = resolve(process.cwd(), "workloads");

    const workloadPath = join(
      workloadsDirectory,
      "naive-comparison-workload-12345.json",
    );

    const historyPath = join(
      workloadsDirectory,
      "naive-comparison-history-12345.jsonl",
    );

    const workload: GeneratedWorkload = JSON.parse(
      await readFile(workloadPath, "utf8"),
    );

    expect(workload.config.seed).toBe(12345);
    expect(workload.transfers).toHaveLength(100);

    const accountIds = new Set(
      workload.transfers.flatMap((transfer) => [
        transfer.fromAccountId,
        transfer.toAccountId,
      ]),
    );

    expect(accountIds.size).toBe(13);

    await writeFile(historyPath, "", "utf8");

    const server = app.listen(0, "127.0.0.1");

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });

      const address = server.address();

      if (!address || typeof address === "string") {
        throw new Error("Could not determine Naive Mode server port.");
      }

      console.log("\nStarting 100-request Naive Mode comparison...");

      const records = await executeAndRecordWorkload(
        workload,
        "NAIVE",
        `http://127.0.0.1:${address.port}`,
        historyPath,
      );

      const parsed = await readHistoryFile(historyPath);

      expect(parsed.errors).toHaveLength(0);
      expect(records).toHaveLength(100);
      expect(parsed.records).toHaveLength(100);

      const requestIds = parsed.records.map(
        (record) => record.requestId,
      );

      expect(new Set(requestIds).size).toBe(100);

      expect([...requestIds].sort()).toEqual(
        workload.transfers
          .map((transfer) => transfer.requestId)
          .sort(),
      );

      const indexes = buildHistoryIndexes(parsed.records);
      const summary = summarizeOutcomes(parsed.records);
      const latency = calculateLatencyPercentiles(parsed.records);

      expect(indexes.byRequestId.size).toBe(100);
      expect(indexes.byCorrelationId.size).toBe(100);

      console.log("\n========== NAIVE MODE REPORT ==========");
      console.log("Seed:", workload.config.seed);
      console.log("Total requests:", summary.totalRecords);
      console.log("Concurrency:", workload.config.concurrency);
      console.log("Request outcomes:", summary.requestOutcomes);
      console.log("Transfer outcomes:", summary.transferOutcomes);
      console.log("Latency (ms):", {
        samples: latency.sampleCount,
        p50: latency.p50,
        p95: latency.p95,
        p99: latency.p99,
      });
      console.log("Saved history:", historyPath);
      console.log("=======================================\n");
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }
    }
  },120_000);
});
