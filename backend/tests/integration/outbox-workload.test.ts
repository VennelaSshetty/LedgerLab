import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { rm } from "node:fs/promises";

import { generateWorkload } from "../../src/workload/generator";
import type { WorkloadConfig } from "../../src/workload/types";
import {
  cleanupStressFixture,
  createStressFixture,
  startStressServer,
  type StressFixture,
  type StressServer,
} from "../helpers/transfer-stress-fixtures";
import { executeAndRecordWorkload } from "../../src/history/recorder";
import { readHistoryFile } from "../../src/history/parser";

import { adminPool } from "../helpers/admin-pool";

import { ControlledOutboxTransport } from "../helpers/controlled-outbox-transport";
import { publishOutboxBatch } from "../../src/services/outbox-publisher.service";

import { verifyI1TotalMoney } from "../../src/verifier/checks/i1-total-money";
import { verifyI2DebitCredit } from "../../src/verifier/checks/i2-debit-credit";
import { verifyI3NoNegativeBalances } from "../../src/verifier/checks/i3-no-negative-balances";
import { verifyI5NoPartialTransfers } from "../../src/verifier/checks/i5-no-partial-transfers";
import { verifyI6ProjectionConsistency } from "../../src/verifier/checks/i6-projection-consistency";

describe("Outbox workload integration", () => {
  const config: WorkloadConfig = {
    seed: 20261121,
    accountCount: 10,
    transferCount: 500,
    minAmountPaise: "100",
    maxAmountPaise: "100000",
    invalidRequestPercentage: 10,
    concurrency: 25,
  };

  let fixture: StressFixture;
  let server: StressServer;

  beforeAll(async () => {
    fixture = await createStressFixture(
      Array(config.accountCount).fill("100000000"),
    );

    server = await startStressServer();
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }

    if (fixture) {
      await cleanupStressFixture(fixture);
    }
  });

  it("generates a reproducible baseline workload", () => {
    const workload = generateWorkload(config, fixture.accountIds);

    const validCount = workload.transfers.filter(
      (transfer) => transfer.expectedValidity === "VALID",
    ).length;

    const invalidCount = workload.transfers.length - validCount;

    expect(workload.transfers).toHaveLength(500);
    expect(validCount).toBe(450);
    expect(invalidCount).toBe(50);

    expect(
      new Set(workload.transfers.map((transfer) => transfer.requestId)).size,
    ).toBe(500);

    console.log("\n========== LEDGERLAB BASELINE WORKLOAD ==========");
    console.log(`Seed:             ${config.seed}`);
    console.log(`Accounts:         ${config.accountCount}`);
    console.log(`Requests:         ${config.transferCount}`);
    console.log(`Expected valid:   ${validCount}`);
    console.log(`Expected invalid: ${invalidCount}`);
    console.log(`Concurrency:      ${config.concurrency}`);
    console.log("=================================================\n");
  });

  it("executes and records the baseline workload", async () => {
    const workload = generateWorkload(config, fixture.accountIds);

    const historyPath = path.resolve(
      process.cwd(),
      "workloads",
      "outbox-baseline-20261121.jsonl",
    );

    await rm(historyPath, { force: true });

    const records = await executeAndRecordWorkload(
      workload,
      "SAFE",
      server.baseUrl,
      historyPath,
      30_000,
    );

    const parsedHistory = await readHistoryFile(historyPath);

    expect(records).toHaveLength(500);
    expect(parsedHistory.errors).toHaveLength(0);
    expect(parsedHistory.records).toHaveLength(500);

    const committed = records.filter(
      (record) => record.transferOutcome === "CONFIRMED_COMMITTED",
    ).length;

    const notCommitted = records.filter(
      (record) => record.transferOutcome === "CONFIRMED_NOT_COMMITTED",
    ).length;

    const unknown = records.filter(
      (record) => record.transferOutcome === "UNKNOWN",
    ).length;

    const successfulRequests = records.filter(
      (record) => record.outcome === "SUCCESS",
    ).length;

    console.log("\n========== BASELINE EXECUTION RESULTS ==========");
    console.log(`Total requests:       ${records.length}`);
    console.log(`Successful requests:  ${successfulRequests}`);
    console.log(`Confirmed committed:  ${committed}`);
    console.log(`Confirmed rejected:   ${notCommitted}`);
    console.log(`Unknown outcomes:     ${unknown}`);
    console.log(`History file:         ${historyPath}`);
    console.log("================================================\n");

    expect(
      new Set(records.map((record) => record.requestId)).size,
    ).toBe(500);
   }, 60_000);


it("continues committing transfers and accumulating outbox events during a messaging outage", async () => {
  const outageConfig: WorkloadConfig = {
    ...config,
    seed: 20261122,
  };

  const workload = generateWorkload(outageConfig, fixture.accountIds);

  const historyPath = path.resolve(
    process.cwd(),
    "workloads",
    "outbox-outage-20261122.jsonl",
  );

  await rm(historyPath, { force: true });

  // Simulate the messaging destination being unavailable.
  // Transfers must still commit through the SAFE API.
  const records = await executeAndRecordWorkload(
    workload,
    "SAFE",
    server.baseUrl,
    historyPath,
    30_000,
  );

  expect(records).toHaveLength(500);

  const committedTransferIds = records
    .filter(
      (record) => record.transferOutcome === "CONFIRMED_COMMITTED",
    )
    .map((record) => record.transferId)
    .filter((id): id is string => id !== null);

  expect(committedTransferIds).toHaveLength(450);
  expect(new Set(committedTransferIds).size).toBe(450);

  // Verify all committed transfers exist in PostgreSQL.
  const transfers = await adminPool.query(
    `SELECT id, status
     FROM transfers
     WHERE id = ANY($1::uuid[])`,
    [committedTransferIds],
  );

  expect(transfers.rows).toHaveLength(450);
  expect(
    transfers.rows.every((transfer) => transfer.status === "COMPLETED"),
  ).toBe(true);

  // Verify exactly one pending outbox event per committed transfer.
  const outbox = await adminPool.query(
    `SELECT transfer_id, COUNT(*)::int AS event_count,
            MIN(status) AS status
     FROM outbox
     WHERE transfer_id = ANY($1::uuid[])
     GROUP BY transfer_id`,
    [committedTransferIds],
  );

  expect(outbox.rows).toHaveLength(450);
  expect(
    outbox.rows.every(
      (event) => event.event_count === 1 && event.status === "PENDING",
    ),
  ).toBe(true);

  console.log("\n========== MESSAGING OUTAGE RESULTS ==========");
  console.log(`Total requests:          ${records.length}`);
  console.log(`Committed transfers:     ${transfers.rows.length}`);
  console.log(`Outbox events persisted: ${outbox.rows.length}`);
  console.log(`Events still pending:    ${outbox.rows.length}`);
  console.log("================================================\n");
}, 60_000);

it("restores messaging and publishes all pending workload events", async () => {
  const historyPath = path.resolve(
    process.cwd(),
    "workloads",
    "outbox-outage-20261122.jsonl",
  );

  // Recover the exact transfer IDs from the outage workload.
  const history = await readHistoryFile(historyPath);

  expect(history.errors).toHaveLength(0);

  const committedTransferIds = history.records
    .filter(
      (record) => record.transferOutcome === "CONFIRMED_COMMITTED",
    )
    .map((record) => record.transferId)
    .filter((id): id is string => id !== null);

  expect(committedTransferIds).toHaveLength(450);

  // Restore the messaging destination.
  const transport = new ControlledOutboxTransport();
  transport.available = true;

  let totalPublished = 0;
  let totalFailed = 0;
  let totalLeaseLost = 0;

  // Publish only events belonging to this workload.
  while (totalPublished < committedTransferIds.length) {
    const batch = await publishOutboxBatch(
      transport,
      25,
      30,
      committedTransferIds,
    );

    totalPublished += batch.published;
    totalFailed += batch.failed;
    totalLeaseLost += batch.leaseLost;

    // Stop if no further events can be claimed.
    if (
      batch.published === 0 &&
      batch.failed === 0 &&
      batch.leaseLost === 0
    ) {
      break;
    }
  }

  // Verify the destination accepted every event.
  expect(transport.acceptedEvents).toHaveLength(450);
  expect(totalPublished).toBe(450);
  expect(totalFailed).toBe(0);
  expect(totalLeaseLost).toBe(0);

  // Verify persisted database states.
  const states = await adminPool.query(
    `SELECT status, COUNT(*)::int AS event_count
     FROM outbox
     WHERE transfer_id = ANY($1::uuid[])
     GROUP BY status`,
    [committedTransferIds],
  );

  const statusCounts = Object.fromEntries(
    states.rows.map((row) => [row.status, row.event_count]),
  );

  expect(statusCounts.PUBLISHED).toBe(450);
  expect(statusCounts.PENDING ?? 0).toBe(0);
  expect(statusCounts.PROCESSING ?? 0).toBe(0);
  expect(statusCounts.FAILED ?? 0).toBe(0);

  console.log("\n========== OUTBOX RECOVERY RESULTS ==========");
  console.log(`Workload transfers:       ${committedTransferIds.length}`);
  console.log(`Events accepted:          ${transport.acceptedEvents.length}`);
  console.log(`Events marked PUBLISHED:  ${totalPublished}`);
  console.log(`Publication failures:     ${totalFailed}`);
  console.log(`Lease losses:              ${totalLeaseLost}`);
  console.log(`Pending events:            ${statusCounts.PENDING ?? 0}`);
  console.log(`Failed events:             ${statusCounts.FAILED ?? 0}`);
  console.log("=============================================\n");
}, 60_000);

it("reconciles baseline and outage workloads against transfer and outbox states", async () => {
  const baselineHistory = await readHistoryFile(
    path.resolve(
      process.cwd(),
      "workloads",
      "outbox-baseline-20261121.jsonl",
    ),
  );

  const outageHistory = await readHistoryFile(
    path.resolve(
      process.cwd(),
      "workloads",
      "outbox-outage-20261122.jsonl",
    ),
  );

  expect(baselineHistory.errors).toHaveLength(0);
  expect(outageHistory.errors).toHaveLength(0);

  const getCommittedIds = (records: typeof baselineHistory.records) =>
    records
      .filter(
        (record) => record.transferOutcome === "CONFIRMED_COMMITTED",
      )
      .map((record) => record.transferId)
      .filter((id): id is string => id !== null);

  const baselineIds = getCommittedIds(baselineHistory.records);
  const outageIds = getCommittedIds(outageHistory.records);

  expect(baselineIds).toHaveLength(450);
  expect(outageIds).toHaveLength(450);
  expect(new Set(baselineIds).size).toBe(450);
  expect(new Set(outageIds).size).toBe(450);

  const allTransferIds = [...baselineIds, ...outageIds];

  const reconciliation = await adminPool.query(
    `
    SELECT
      t.id,
      t.status AS transfer_status,
      COUNT(o.id)::int AS event_count,
      COUNT(o.id) FILTER (
        WHERE o.status = 'PUBLISHED'
      )::int AS published_count,
      COUNT(o.id) FILTER (
        WHERE o.status = 'PENDING'
      )::int AS pending_count,
      COUNT(o.id) FILTER (
        WHERE o.status = 'PROCESSING'
      )::int AS processing_count,
      COUNT(o.id) FILTER (
        WHERE o.status = 'FAILED'
      )::int AS failed_count
    FROM transfers t
    LEFT JOIN outbox o ON o.transfer_id = t.id
    WHERE t.id = ANY($1::uuid[])
    GROUP BY t.id, t.status
    `,
    [allTransferIds],
  );

  expect(reconciliation.rows).toHaveLength(900);

  const resultsById = new Map(
    reconciliation.rows.map((row) => [row.id, row]),
  );

  const baselineResults = baselineIds.map((id) => resultsById.get(id)!);
  const outageResults = outageIds.map((id) => resultsById.get(id)!);

  // Every confirmed transfer must exist and have exactly one event.
  for (const row of [...baselineResults, ...outageResults]) {
    expect(row.transfer_status).toBe("COMPLETED");
    expect(row.event_count).toBe(1);
  }

  // Baseline workload was not published.
  expect(
    baselineResults.every(
      (row) =>
        row.pending_count === 1 &&
        row.published_count === 0 &&
        row.processing_count === 0 &&
        row.failed_count === 0,
    ),
  ).toBe(true);

  // Outage workload was fully recovered and published.
  expect(
    outageResults.every(
      (row) =>
        row.published_count === 1 &&
        row.pending_count === 0 &&
        row.processing_count === 0 &&
        row.failed_count === 0,
    ),
  ).toBe(true);

  console.log("\n========== WORKLOAD RECONCILIATION ==========");
  console.log("                         Baseline    Outage");
  console.log(`Committed transfers:     ${baselineResults.length}          ${outageResults.length}`);
  console.log(`Outbox events:           ${baselineResults.reduce((sum, row) => sum + row.event_count, 0)}          ${outageResults.reduce((sum, row) => sum + row.event_count, 0)}`);
  console.log(`Published:               ${baselineResults.reduce((sum, row) => sum + row.published_count, 0)}            ${outageResults.reduce((sum, row) => sum + row.published_count, 0)}`);
  console.log(`Pending:                 ${baselineResults.reduce((sum, row) => sum + row.pending_count, 0)}          ${outageResults.reduce((sum, row) => sum + row.pending_count, 0)}`);
  console.log(`Processing:              ${baselineResults.reduce((sum, row) => sum + row.processing_count, 0)}            ${outageResults.reduce((sum, row) => sum + row.processing_count, 0)}`);
  console.log(`Failed:                  ${baselineResults.reduce((sum, row) => sum + row.failed_count, 0)}            ${outageResults.reduce((sum, row) => sum + row.failed_count, 0)}`);
  console.log("=============================================\n");
}, 60_000);

it(
  "independently verifies financial invariants after the outbox workload",
  async () => {
    const results = await Promise.all([
      verifyI1TotalMoney(fixture.accountIds),
      verifyI2DebitCredit(fixture.accountIds),
      verifyI3NoNegativeBalances(fixture.accountIds),
      verifyI5NoPartialTransfers(fixture.accountIds),
      verifyI6ProjectionConsistency(fixture.accountIds),
    ]);

    console.log("\n========== INDEPENDENT FINANCIAL VERIFICATION ==========");

    for (const result of results) {
      console.log(
        `[${result.status}] ${result.invariant} - ${result.name}`,
      );
      console.log(`  ${result.message}`);
    }

    console.log("========================================================\n");

    for (const result of results) {
      expect(
        result.status,
        `${result.invariant}: ${result.message}`,
      ).toBe("PASS");
    }
  },
  60_000,
);

});
