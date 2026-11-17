import {
  afterAll,
  describe,
  expect,
  it,
} from "vitest";

import { pool } from "../../src/db/pool";
import { adminPool } from "../helpers/admin-pool";
import {
  cleanupStressFixture,
  createStressFixture,
  startStressServer,
} from "../helpers/transfer-stress-fixtures";
import type { StressFixture, StressServer } from "../helpers/transfer-stress-fixtures";
import { executeStressTransfers } from "../helpers/transfer-stress-harness";
import type { WorkloadTransfer } from "../../src/workload/types";

import { verifierPool } from "../../src/db/verifier-pool";

import { verifyI1TotalMoney } from "../../src/verifier/checks/i1-total-money";
import { verifyI2DebitCredit } from "../../src/verifier/checks/i2-debit-credit";
import { verifyI3NoNegativeBalances } from "../../src/verifier/checks/i3-no-negative-balances";
import { verifyI5NoPartialTransfers } from "../../src/verifier/checks/i5-no-partial-transfers";
import { verifyI6ProjectionConsistency } from "../../src/verifier/checks/i6-projection-consistency";

async function verifyLedgerInvariants() {
  const results = await Promise.all([
    verifyI1TotalMoney(),
    verifyI2DebitCredit(),
    verifyI3NoNegativeBalances(),
    verifyI5NoPartialTransfers(),
    verifyI6ProjectionConsistency(),
  ]);

  const names = ["I1", "I2", "I3", "I5", "I6"];

  console.log("\n========== INDEPENDENT LEDGER VERIFICATION ==========");

  results.forEach((result, index) => {
    console.log(`${names[index]}: ${result.status}`);
  });

  console.log("=====================================================\n");

  expect(
    results.every((result) => result.status === "PASS"),
    results.map((result, index) =>
      `${names[index]}: ${result.status}`,
    ).join("\n"),
  ).toBe(true);
}

describe("Transfer concurrency stress tests", () => {
 afterAll(async () => {
  await pool.end();
  await adminPool.end();
  await verifierPool.end();
});

  it(
    "prevents overdrawing an account under 1,000 concurrent transfers",
    async () => {
      const fixture: StressFixture = await createStressFixture([
        "100000",
        "0",
      ]);

      let server: StressServer | null = null;

      try {
        const [senderId, receiverId] = fixture.accountIds;

        server = await startStressServer();

        const transfers: WorkloadTransfer[] = Array.from(
          { length: 1000 },
          (_, index) => ({
            requestId: `stress-a-request-${index}`,
            correlationId: `stress-a-correlation-${index}`,
            fromAccountId: senderId,
            toAccountId: receiverId,
            amountPaise: "10000",
            idempotencyKey: `stress-a-key-${index}`,
            expectedValidity: "VALID",
          }),
        );

        const results = await executeStressTransfers(
          transfers,
          server.baseUrl,
          1000,
          60_000,
        );

        const successful = results.filter(
          (result) => result.outcome === "SUCCESS",
        );

        const failed = results.filter(
          (result) => result.outcome === "FAILURE",
        );

        const uncertain = results.filter(
          (result) => result.transferOutcome === "UNKNOWN",
        );

        console.log("\n========== DEBUG OUTCOMES ==========");
console.log("Total:", results.length);
console.log("Success:", successful.length);
console.log("Failure:", failed.length);
console.log("Unknown:", uncertain.length);

console.log(
  "HTTP statuses:",
  results.reduce<Record<string, number>>((counts, result) => {
    const status = String(result.result?.httpStatus ?? "NO_RESPONSE");
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {}),
);

console.log(
  "Error types:",
  results.reduce<Record<string, number>>((counts, result) => {
    const type = result.historyError?.type ?? "NONE";
    counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  }, {}),
);

console.log(
  "Error codes:",
  results.reduce<Record<string, number>>((counts, result) => {
    const code = result.historyError?.code ?? "NONE";
    counts[code] = (counts[code] ?? 0) + 1;
    return counts;
  }, {}),
);

console.log("===================================\n");

        // Every HTTP request must have a recorded result.
        expect(results).toHaveLength(1000);
        expect(successful).toHaveLength(10);
        expect(failed).toHaveLength(990);
        expect(uncertain).toHaveLength(0);

        // Every failed request must be a confirmed non-commit.
        expect(
          failed.every(
            (result) =>
              result.transferOutcome === "CONFIRMED_NOT_COMMITTED",
          ),
        ).toBe(true);

        // Verify final account projections and independently
        // reconstruct balances from opening balances and ledger entries.
        const balances = await adminPool.query<{
          id: string;
          balance_paise: string;
          opening_paise: string;
          debit_paise: string;
          credit_paise: string;
        }>(
          `SELECT
             a.id,
             a.balance_paise::text AS balance_paise,
             ob.amount_paise::text AS opening_paise,
             COALESCE(
               SUM(le.amount_paise)
                 FILTER (WHERE le.entry_type = 'DEBIT'),
               0
             )::text AS debit_paise,
             COALESCE(
               SUM(le.amount_paise)
                 FILTER (WHERE le.entry_type = 'CREDIT'),
               0
             )::text AS credit_paise
           FROM accounts a
           JOIN account_opening_balances ob
             ON ob.account_id = a.id
           LEFT JOIN ledger_entries le
             ON le.account_id = a.id
           WHERE a.id = ANY($1::uuid[])
           GROUP BY
             a.id,
             a.balance_paise,
             ob.amount_paise
           ORDER BY a.id`,
          [fixture.accountIds],
        );

        expect(balances.rows).toHaveLength(2);

        for (const account of balances.rows) {
          const ledgerBalance =
            BigInt(account.opening_paise) +
            BigInt(account.credit_paise) -
            BigInt(account.debit_paise);

          expect(BigInt(account.balance_paise)).toBe(ledgerBalance);
          expect(BigInt(account.balance_paise)).toBeGreaterThanOrEqual(0n);
        }

        const sender = balances.rows.find(
          (account) => account.id === senderId,
        );

        const receiver = balances.rows.find(
          (account) => account.id === receiverId,
        );

        expect(sender?.balance_paise).toBe("0");
        expect(receiver?.balance_paise).toBe("100000");

        // Exactly ten transfers should have been committed.
        const transferCount = await adminPool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM transfers
           WHERE from_account_id = $1
             AND to_account_id = $2`,
          [senderId, receiverId],
        );

        expect(transferCount.rows[0].count).toBe("10");

        // Each committed transfer must have one debit and one credit.
        const ledgerCount = await adminPool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM ledger_entries
           WHERE account_id = ANY($1::uuid[])`,
          [fixture.accountIds],
        );

        expect(ledgerCount.rows[0].count).toBe("20");

        // Find any transfer with missing, duplicated, or unbalanced entries.
        const partialTransfers = await adminPool.query(
          `SELECT
             t.id,
             t.amount_paise::text AS amount_paise,
             COUNT(le.id)::int AS entry_count,
             COUNT(*) FILTER (
               WHERE le.entry_type = 'DEBIT'
             )::int AS debit_count,
             COUNT(*) FILTER (
               WHERE le.entry_type = 'CREDIT'
             )::int AS credit_count,
             COALESCE(
               SUM(le.amount_paise)
                 FILTER (WHERE le.entry_type = 'DEBIT'),
               0
             )::text AS debit_total,
             COALESCE(
               SUM(le.amount_paise)
                 FILTER (WHERE le.entry_type = 'CREDIT'),
               0
             )::text AS credit_total
           FROM transfers t
           LEFT JOIN ledger_entries le
             ON le.transfer_id = t.id
           WHERE t.from_account_id = ANY($1::uuid[])
              OR t.to_account_id = ANY($1::uuid[])
           GROUP BY t.id, t.amount_paise
           HAVING
             COUNT(le.id) <> 2
             OR COUNT(*) FILTER (
               WHERE le.entry_type = 'DEBIT'
             ) <> 1
             OR COUNT(*) FILTER (
               WHERE le.entry_type = 'CREDIT'
             ) <> 1
             OR COALESCE(
               SUM(le.amount_paise)
                 FILTER (WHERE le.entry_type = 'DEBIT'),
               0
             ) <> t.amount_paise
             OR COALESCE(
               SUM(le.amount_paise)
                 FILTER (WHERE le.entry_type = 'CREDIT'),
               0
             ) <> t.amount_paise`,
          [fixture.accountIds],
        );

        expect(partialTransfers.rows).toHaveLength(0);

        console.log("\n========== SCENARIO A REPORT ==========");
        console.log("Concurrent requests: 1000");
        console.log("Successful transfers:", successful.length);
        console.log("Failed transfers:", failed.length);
        console.log("Unknown outcomes:", uncertain.length);
        console.log("Sender final balance:", sender?.balance_paise);
        console.log("Receiver final balance:", receiver?.balance_paise);
        console.log("Ledger entries:", ledgerCount.rows[0].count);
        console.log("Partial transfers:", partialTransfers.rows.length);
        console.log("=======================================\n");

        await verifyLedgerInvariants();
      } finally {
        if (server) {
          await server.close();
        }

        await cleanupStressFixture(fixture);
      }
    },
    120_000,
  );


  it(
    "creates only one transfer for 50 simultaneous duplicate requests",
    async () => {
      const fixture: StressFixture = await createStressFixture([
        "100000",
        "0",
      ]);

      let server: StressServer | null = null;

      try {
        const [senderId, receiverId] = fixture.accountIds;

        server = await startStressServer();

        const transfers: WorkloadTransfer[] = Array.from(
          { length: 50 },
          (_, index) => ({
            requestId: `stress-b-request-${index}`,
            correlationId: "stress-b-shared-correlation",
            fromAccountId: senderId,
            toAccountId: receiverId,
            amountPaise: "10000",
            idempotencyKey: "stress-b-shared-idempotency-key",
            expectedValidity: "VALID",
          }),
        );

        const results = await executeStressTransfers(
          transfers,
          server.baseUrl,
          50,
          60_000,
        );

        expect(results).toHaveLength(50);

        const successful = results.filter(
          (result) => result.outcome === "SUCCESS",
        );

        expect(successful).toHaveLength(50);

        const transferIds = new Set(
          results.map((result) => result.result?.transferId),
        );

        expect(transferIds.size).toBe(1);
        expect(transferIds.has(null)).toBe(false);

        const responseBodies = results.map(
          (result) => result.result?.responseBody,
        );

        const replayedCount = responseBodies.filter(
          (body) =>
            typeof body === "object" &&
            body !== null &&
            "replayed" in body &&
            body.replayed === true,
        ).length;

        expect(replayedCount).toBe(49);

        const transferCount = await adminPool.query<{
          count: string;
        }>(
          `SELECT COUNT(*)::text AS count
           FROM transfers
           WHERE from_account_id = $1
             AND to_account_id = $2`,
          [senderId, receiverId],
        );

        expect(transferCount.rows[0].count).toBe("1");

        const ledgerCount = await adminPool.query<{
          count: string;
        }>(
          `SELECT COUNT(*)::text AS count
           FROM ledger_entries
           WHERE account_id = ANY($1::uuid[])`,
          [fixture.accountIds],
        );

        expect(ledgerCount.rows[0].count).toBe("2");

        const balances = await adminPool.query<{
          id: string;
          balance_paise: string;
        }>(
          `SELECT id, balance_paise::text AS balance_paise
           FROM accounts
           WHERE id = ANY($1::uuid[])`,
          [fixture.accountIds],
        );

        const sender = balances.rows.find(
          (account) => account.id === senderId,
        );

        const receiver = balances.rows.find(
          (account) => account.id === receiverId,
        );

        expect(sender?.balance_paise).toBe("90000");
        expect(receiver?.balance_paise).toBe("10000");

        console.log("\n========== SCENARIO B REPORT ==========");
        console.log("Concurrent duplicate requests:", results.length);
        console.log("Successful responses:", successful.length);
        console.log("Idempotent replays:", replayedCount);
        console.log("Unique transfer IDs:", transferIds.size);
        console.log("Database transfers:", transferCount.rows[0].count);
        console.log("Ledger entries:", ledgerCount.rows[0].count);
        console.log("Sender final balance:", sender?.balance_paise);
        console.log("Receiver final balance:", receiver?.balance_paise);
        console.log("=======================================\n");

        await verifyLedgerInvariants();
      } finally {
        if (server) {
          await server.close();
        }

        await cleanupStressFixture(fixture);
      }
    },
    120_000,
  );


  it(
    "handles repeated opposite-direction transfers without deadlocks",
    async () => {
      const fixture: StressFixture = await createStressFixture([
        "1000000",
        "1000000",
      ]);

      let server: StressServer | null = null;

      try {
        const [accountA, accountB] = fixture.accountIds;

        server = await startStressServer();

        const deadlocksBefore = await adminPool.query<{
          deadlocks: string;
        }>(
          `SELECT deadlocks::text AS deadlocks
           FROM pg_stat_database
           WHERE datname = current_database()`,
        );

        const allResults = [];

        // Five rounds, with 100 transfers in each direction per round.
        for (let round = 0; round < 5; round++) {
          const transfers: WorkloadTransfer[] = Array.from(
            { length: 200 },
            (_, index) => {
              const requestIndex = round * 200 + index;
              const aToB = index % 2 === 0;

              return {
                requestId: `stress-c-request-${requestIndex}`,
                correlationId: `stress-c-correlation-${requestIndex}`,
                fromAccountId: aToB ? accountA : accountB,
                toAccountId: aToB ? accountB : accountA,
                amountPaise: "1000",
                idempotencyKey: `stress-c-key-${requestIndex}`,
                expectedValidity: "VALID",
              };
            },
          );

          const results = await executeStressTransfers(
            transfers,
            server.baseUrl,
            200,
            60_000,
          );

          allResults.push(...results);
        }

        const successful = allResults.filter(
          (result) => result.outcome === "SUCCESS",
        );

        const uncertain = allResults.filter(
          (result) => result.transferOutcome === "UNKNOWN",
        );

        expect(allResults).toHaveLength(1000);
        expect(successful).toHaveLength(1000);
        expect(uncertain).toHaveLength(0);

        const deadlocksAfter = await adminPool.query<{
          deadlocks: string;
        }>(
          `SELECT deadlocks::text AS deadlocks
           FROM pg_stat_database
           WHERE datname = current_database()`,
        );

        const deadlocksDelta =
          BigInt(deadlocksAfter.rows[0].deadlocks) -
          BigInt(deadlocksBefore.rows[0].deadlocks);

        expect(deadlocksDelta).toBe(0n);

        const balances = await adminPool.query<{
          id: string;
          balance_paise: string;
          opening_paise: string;
          debit_paise: string;
          credit_paise: string;
        }>(
          `SELECT
             a.id,
             a.balance_paise::text AS balance_paise,
             ob.amount_paise::text AS opening_paise,
             COALESCE(
               SUM(le.amount_paise)
                 FILTER (WHERE le.entry_type = 'DEBIT'),
               0
             )::text AS debit_paise,
             COALESCE(
               SUM(le.amount_paise)
                 FILTER (WHERE le.entry_type = 'CREDIT'),
               0
             )::text AS credit_paise
           FROM accounts a
           JOIN account_opening_balances ob
             ON ob.account_id = a.id
           LEFT JOIN ledger_entries le
             ON le.account_id = a.id
           WHERE a.id = ANY($1::uuid[])
           GROUP BY
             a.id,
             a.balance_paise,
             ob.amount_paise
           ORDER BY a.id`,
          [fixture.accountIds],
        );

        expect(balances.rows).toHaveLength(2);

        for (const account of balances.rows) {
          const ledgerBalance =
            BigInt(account.opening_paise) +
            BigInt(account.credit_paise) -
            BigInt(account.debit_paise);

          expect(BigInt(account.balance_paise)).toBe(ledgerBalance);
          expect(BigInt(account.balance_paise)).toBeGreaterThanOrEqual(0n);
          expect(account.balance_paise).toBe("1000000");
        }

        const transferCount = await adminPool.query<{
          count: string;
        }>(
          `SELECT COUNT(*)::text AS count
           FROM transfers
           WHERE from_account_id = ANY($1::uuid[])
              OR to_account_id = ANY($1::uuid[])`,
          [fixture.accountIds],
        );

        expect(transferCount.rows[0].count).toBe("1000");

        const ledgerCount = await adminPool.query<{
          count: string;
        }>(
          `SELECT COUNT(*)::text AS count
           FROM ledger_entries
           WHERE account_id = ANY($1::uuid[])`,
          [fixture.accountIds],
        );

        expect(ledgerCount.rows[0].count).toBe("2000");

        console.log("\n========== SCENARIO C REPORT ==========");
        console.log("Rounds:", 5);
        console.log("Requests per round:", 200);
        console.log("Total requests:", allResults.length);
        console.log("Successful transfers:", successful.length);
        console.log("Unknown outcomes:", uncertain.length);
        console.log("Database transfers:", transferCount.rows[0].count);
        console.log("Ledger entries:", ledgerCount.rows[0].count);
        console.log("Account A final balance:", balances.rows.find(
          (account) => account.id === accountA,
        )?.balance_paise);
        console.log("Account B final balance:", balances.rows.find(
          (account) => account.id === accountB,
        )?.balance_paise);
        console.log("PostgreSQL deadlock counter increase:", deadlocksDelta.toString());
        console.log("=======================================\n");

        await verifyLedgerInvariants();
      } finally {
        if (server) {
          await server.close();
        }

        await cleanupStressFixture(fixture);
      }
    },
    180_000,
  );


});
