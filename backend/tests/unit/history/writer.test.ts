import { describe, it, expect } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistoryWriter } from "../../../src/history/writer";
import type { HistoryRecord } from "../../../src/history/types";

function createTestRecord(index: number): HistoryRecord {
  return {
    recordVersion: 1,
    requestId: `request-${index}`,
    correlationId: `correlation-${index}`,
    idempotencyKey: `key-${index}`,
    mode: "SAFE",
    fromAccountId: "account-001",
    toAccountId: "account-002",
    amountPaise: "10000",
    expectedValidity: "VALID",
    invalidReason: null,
    requestStartedAt: "2026-11-17T10:00:00.000Z",
    responseReceivedAt: "2026-11-17T10:00:00.010Z",
    durationMs: 10,
    httpStatus: 201,
    outcome: "SUCCESS",
    transferOutcome: "CONFIRMED_COMMITTED",
    transferId: `transfer-${index}`,
    timeoutMs: 10000,
    error: null,
  };
}

describe("History writer", () => {
  it("writes records as separate JSONL lines", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "ledgerlab-history-"),
    );

    const filePath = join(directory, "history.jsonl");
    const writer = await createHistoryWriter(filePath);

    try {
      await writer.write(createTestRecord(1));
      await writer.write(createTestRecord(2));

      const content = await readFile(filePath, "utf8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(2);

      expect(JSON.parse(lines[0]).requestId).toBe("request-1");
      expect(JSON.parse(lines[1]).requestId).toBe("request-2");

      expect(content.endsWith("\n")).toBe(true);
    } finally {
      await writer.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("safely handles concurrent writes without losing records", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "ledgerlab-history-"),
    );

    const filePath = join(directory, "history.jsonl");
    const writer = await createHistoryWriter(filePath);

    try {
      const records = Array.from(
        { length: 100 },
        (_, index) => createTestRecord(index),
      );

      await Promise.all(
        records.map((record) => writer.write(record)),
      );

      const content = await readFile(filePath, "utf8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(100);

      const parsedRecords = lines.map(
        (line) => JSON.parse(line) as HistoryRecord,
      );

      const requestIds = parsedRecords.map(
        (record) => record.requestId,
      );

      expect(new Set(requestIds).size).toBe(100);

      for (const record of records) {
        expect(requestIds).toContain(record.requestId);
      }
    } finally {
      await writer.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("appends to existing history instead of overwriting it", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "ledgerlab-history-"),
    );

    const filePath = join(directory, "history.jsonl");

    try {
      await writeFile(
        filePath,
        `${JSON.stringify(createTestRecord(1))}\n`,
        "utf8",
      );

      const writer = await createHistoryWriter(filePath);

      try {
        await writer.write(createTestRecord(2));
      } finally {
        await writer.close();
      }

      const content = await readFile(filePath, "utf8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).requestId).toBe("request-1");
      expect(JSON.parse(lines[1]).requestId).toBe("request-2");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates missing destination directories", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "ledgerlab-history-"),
    );

    const filePath = join(
      directory,
      "nested",
      "output",
      "history.jsonl",
    );

    const writer = await createHistoryWriter(filePath);

    try {
      await writer.write(createTestRecord(1));

      const content = await readFile(filePath, "utf8");

      expect(JSON.parse(content).requestId).toBe("request-1");
    } finally {
      await writer.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects writes after closing", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "ledgerlab-history-"),
    );

    const filePath = join(directory, "history.jsonl");
    const writer = await createHistoryWriter(filePath);

    try {
      await writer.close();

      await expect(
        writer.write(createTestRecord(1)),
      ).rejects.toThrow("Cannot write to a closed history writer.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});