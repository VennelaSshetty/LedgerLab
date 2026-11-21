
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import app from "../../src/app";
import { adminPool } from "../helpers/admin-pool";
import { executeAndRecordWorkload } from "../../src/history/recorder";
import { readHistoryFile } from "../../src/history/parser";
import { buildHistoryIndexes } from "../../src/history/indexes";
import type { GeneratedWorkload } from "../../src/workload/types";

describe("History Recorder integration", () => {
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
        await new Promise<void>((resolve, reject) => {
          server.once("listening", resolve);
          server.once("error", reject);
        });

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
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) reject(error);
              else resolve();
            });
          });
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
